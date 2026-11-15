//! Local-only control for tmctl. The random credential is stored in the user's private config dir.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

const MAX_REQUEST: u64 = 1024 * 1024;

#[derive(Serialize, Deserialize)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

#[derive(Serialize, Deserialize)]
pub struct Request {
    pub token: String,
    pub action: String,
    pub args: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiRequest {
    pub request_id: String,
    pub action: String,
    pub args: Value,
}

#[derive(Default)]
pub struct Pending {
    pub requests: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    pub ready: AtomicBool,
}

pub fn start(app: AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let endpoint = Endpoint {
        port: listener.local_addr().unwrap().port(),
        token: uuid::Uuid::new_v4().to_string(),
    };
    super::storage::atomic_write("control.json", &serde_json::to_vec(&endpoint).unwrap())?;
    thread::spawn(move || {
        // Serialize local requests; no thread-per-connection or busy polling.
        for stream in listener.incoming().flatten() {
            let _ = serve(stream, &endpoint.token, &app);
        }
    });
    Ok(())
}

fn serve(mut stream: TcpStream, token: &str, app: &AppHandle) -> Result<(), String> {
    use std::io::Read;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new((&stream).take(MAX_REQUEST + 1))
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    if line.len() as u64 > MAX_REQUEST {
        return Err("request too large".into());
    }
    let response = match serde_json::from_str::<Request>(&line) {
        Ok(request) if request.token == token => {
            let id = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = mpsc::channel();
            let pending = app.state::<Pending>();
            if !pending.ready.load(Ordering::Acquire) {
                stream
                    .write_all(b"{\"error\":\"Application is starting; retry shortly\"}\n")
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
            pending.requests.lock().unwrap().insert(id.clone(), tx);
            let event = UiRequest {
                request_id: id.clone(),
                action: request.action,
                args: request.args,
            };
            let result = if app.emit_to("main", "control-request", event).is_ok() {
                rx.recv_timeout(Duration::from_secs(10))
                    .unwrap_or_else(|_| json!({"error":"界面未响应，请确认应用窗口已就绪"}))
            } else {
                json!({"error":"无法连接应用界面"})
            };
            pending.requests.lock().unwrap().remove(&id);
            result
        }
        _ => json!({"error":"无效请求或凭据"}),
    };
    let mut body = serde_json::to_vec(&response).map_err(|e| e.to_string())?;
    body.push(b'\n');
    stream.write_all(&body).map_err(|e| e.to_string())
}
