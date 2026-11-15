mod pty;
mod rpc;
mod storage;

use pty::{SpawnOptions, SpawnResult, Terminals};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    ipc::{Channel, Response},
    Emitter, Manager, State,
};

#[derive(Default)]
struct Lifecycle {
    quitting: AtomicBool,
    saving: Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Defaults {
    shell: String,
    cwd: String,
    config_dir: String,
}

#[tauri::command]
fn defaults() -> Defaults {
    Defaults {
        shell: pty::default_shell(),
        cwd: pty::home_dir().to_string_lossy().into(),
        config_dir: storage::config_dir().to_string_lossy().into(),
    }
}

#[tauri::command]
fn load_workspace() -> Result<Option<Value>, String> {
    let path = storage::config_dir().join("workspace.json");
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read(&path).map_err(|e| e.to_string())?;
    // Do not overwrite a corrupt file silently; UI reports this and disables automatic saves.
    serde_json::from_slice(&data)
        .map(Some)
        .map_err(|e| format!("配置读取失败（{}）：{e}", path.display()))
}

#[tauri::command]
fn save_workspace(workspace: Value, lifecycle: State<'_, Lifecycle>) -> Result<(), String> {
    let _guard = lifecycle.saving.lock().unwrap();
    let bytes = serde_json::to_vec_pretty(&workspace).map_err(|e| e.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("配置文件过大".into());
    }
    storage::atomic_write("workspace.json", &bytes)
}

#[tauri::command]
async fn create_terminal(
    options: SpawnOptions,
    output: Channel<Response>,
    app: tauri::AppHandle,
) -> Result<SpawnResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let id = options.id.clone();
        let complete_app = app.clone();
        app.state::<Terminals>().spawn(
            options,
            move |bytes| output.send(Response::new(bytes)).map_err(|e| e.to_string()),
            move |code, error| {
                let _ = complete_app.emit_to(
                    "main",
                    "terminal-exit",
                    serde_json::json!({"id":id,"code":code,"error":error}),
                );
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_terminal(id: String, data: String, app: tauri::AppHandle) -> Result<(), String> {
    let session = app.state::<Terminals>().get(&id)?;
    tauri::async_runtime::spawn_blocking(move || session.write(data.as_bytes()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn resize_terminal(
    id: String,
    cols: u16,
    rows: u16,
    terminals: State<'_, Terminals>,
) -> Result<(), String> {
    terminals.get(&id)?.resize(cols, rows)
}

#[tauri::command]
fn ack_output(id: String, bytes: usize, terminals: State<'_, Terminals>) {
    if let Ok(session) = terminals.get(&id) {
        session.flow.ack(bytes);
    }
}

#[tauri::command]
async fn close_terminal(id: String, app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Terminals>().close(&id))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn control_response(request_id: String, response: Value, pending: State<'_, rpc::Pending>) {
    if let Some(tx) = pending.requests.lock().unwrap().remove(&request_id) {
        let _ = tx.send(response);
    }
}

#[tauri::command]
fn frontend_ready(pending: State<'_, rpc::Pending>) {
    pending.ready.store(true, Ordering::Release);
}

#[tauri::command]
fn focus_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.state::<Lifecycle>()
        .quitting
        .store(true, Ordering::Release);
    app.state::<Terminals>().close_all();
    app.exit(0);
}

pub fn run() {
    let _instance_lock = match storage::prepare() {
        Ok(lock) => lock,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };
    let app = tauri::Builder::default()
        .manage(Terminals::default())
        .manage(Lifecycle::default())
        .manage(rpc::Pending::default())
        .invoke_handler(tauri::generate_handler![
            defaults,
            load_workspace,
            save_workspace,
            create_terminal,
            write_terminal,
            resize_terminal,
            ack_output,
            close_terminal,
            control_response,
            focus_window,
            frontend_ready,
            quit_app
        ])
        .setup(|app| {
            rpc::start(app.handle().clone()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if app.state::<Terminals>().has_running()
                    && !app.state::<Lifecycle>().quitting.load(Ordering::Acquire)
                {
                    api.prevent_close();
                    let _ = app.emit_to("main", "confirm-quit", ());
                } else {
                    app.exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("无法启动 Terminal Manager");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if app.state::<Terminals>().has_running()
                && !app.state::<Lifecycle>().quitting.load(Ordering::Acquire)
            {
                api.prevent_exit();
                let _ = app.emit_to("main", "confirm-quit", ());
            }
        }
        tauri::RunEvent::Exit => {
            app.state::<Terminals>().close_all();
            let _ = fs::remove_file(storage::config_dir().join("control.json"));
        }
        _ => {}
    });
}
