use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
};

pub const MAX_PENDING: usize = 256 * 1024;
const MAX_TERMINALS: usize = 128;

#[derive(Default)]
struct FlowState {
    pending: usize,
    closed: bool,
}

#[derive(Default)]
pub struct Flow {
    state: Mutex<FlowState>,
    ready: Condvar,
}

impl Flow {
    fn reserve(&self, bytes: usize) -> bool {
        let mut state = self.state.lock().unwrap();
        while !state.closed && state.pending + bytes > MAX_PENDING {
            state = self.ready.wait(state).unwrap();
        }
        if state.closed {
            return false;
        }
        state.pending += bytes;
        true
    }

    pub fn ack(&self, bytes: usize) {
        let mut state = self.state.lock().unwrap();
        state.pending = state.pending.saturating_sub(bytes);
        self.ready.notify_one();
    }

    fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.ready.notify_all();
    }
}

pub struct Session {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub flow: Flow,
    pub exited: AtomicBool,
}

impl Session {
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        if data.len() > 1024 * 1024 {
            return Err("输入超过 1 MiB，请分批粘贴".into());
        }
        let mut writer = self.writer.lock().unwrap();
        writer
            .as_mut()
            .ok_or("终端已结束")?
            .write_all(data)
            .map_err(|e| e.to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = self.master.lock().unwrap();
        master
            .as_ref()
            .ok_or("终端已结束")?
            .resize(PtySize {
                cols: cols.clamp(2, 1000),
                rows: rows.clamp(1, 500),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn close(&self) {
        self.flow.close();
        if !self.exited.load(Ordering::Acquire) {
            let _ = self.killer.lock().unwrap().kill();
        }
        self.writer.lock().unwrap().take();
        self.master.lock().unwrap().take();
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub id: String,
    #[serde(default)]
    pub logical_id: String,
    pub cwd: String,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub pid: Option<u32>,
    pub shell: String,
    pub cwd: String,
}

#[derive(Default)]
pub struct Terminals {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

pub fn default_shell() -> String {
    if cfg!(windows) {
        // Prefer PowerShell 7 when on PATH; otherwise Windows PowerShell is built in.
        let has_pwsh = std::env::var_os("PATH").is_some_and(|paths| {
            std::env::split_paths(&paths).any(|p| p.join("pwsh.exe").is_file())
        });
        if has_pwsh {
            "pwsh.exe".into()
        } else {
            "powershell.exe".into()
        }
    } else {
        std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".into())
    }
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn resolve_cwd(cwd: &str) -> Result<PathBuf, String> {
    let cwd = cwd.trim();
    let path = if cwd.is_empty() || cwd == "~" {
        home_dir()
    } else if let Some(rest) = cwd.strip_prefix("~/") {
        home_dir().join(rest)
    } else {
        PathBuf::from(cwd)
    };
    if !path.is_dir() {
        return Err(format!("目录不存在：{}", path.display()));
    }
    path.canonicalize().map_err(|e| e.to_string())
}

impl Terminals {
    pub fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "终端不存在或已关闭".into())
    }

    pub fn has_running(&self) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .any(|s| !s.exited.load(Ordering::Acquire))
    }

    pub fn spawn(
        &self,
        options: SpawnOptions,
        output: impl Fn(Vec<u8>) -> Result<(), String> + Send + 'static,
        done: impl Fn(u32, Option<String>) + Send + 'static,
    ) -> Result<SpawnResult, String> {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.len() >= MAX_TERMINALS {
            return Err("最多同时保留 128 个终端，请先关闭不用的终端".into());
        }
        if sessions.contains_key(&options.id) {
            return Err("终端 ID 已存在".into());
        }
        let cwd = resolve_cwd(&options.cwd)?;
        let shell = if options.shell.trim().is_empty() {
            default_shell()
        } else {
            options.shell.clone()
        };
        let pair = native_pty_system()
            .openpty(PtySize {
                cols: options.cols.clamp(2, 1000),
                rows: options.rows.clamp(1, 500),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "TerminalManager");
        cmd.env(
            "TM_TERMINAL_ID",
            if options.logical_id.is_empty() {
                &options.id
            } else {
                &options.logical_id
            },
        );
        // Each shell loads its own user configuration. Never use -NoProfile.
        let name = PathBuf::from(&shell)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        if ["powershell", "pwsh"].contains(&name.as_str()) {
            cmd.arg("-NoLogo");
        } else if name == "cmd" {
            cmd.arg("/Q");
        } else if !cfg!(windows) && ["bash", "zsh", "fish", "sh", "ksh"].contains(&name.as_str()) {
            cmd.arg("-l");
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let pid = child.process_id();
        // If pipe setup fails after spawning, do not leak a child.
        let handles = (|| {
            Ok::<_, String>((
                pair.master.try_clone_reader().map_err(|e| e.to_string())?,
                pair.master.take_writer().map_err(|e| e.to_string())?,
            ))
        })();
        let (mut reader, writer) = match handles {
            Ok(handles) => handles,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let session = Arc::new(Session {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(child.clone_killer()),
            flow: Flow::default(),
            exited: AtomicBool::new(false),
        });
        sessions.insert(options.id.clone(), session.clone());
        drop(sessions);
        thread::spawn(move || {
            let mut buffer = vec![0; 16 * 1024];
            let mut failure = None;
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !session.flow.reserve(n) {
                            break;
                        }
                        if output(buffer[..n].to_vec()).is_err() {
                            session.close();
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    // Unix PTYs commonly report EIO at EOF.
                    Err(e) if cfg!(unix) && e.raw_os_error() == Some(5) => break,
                    Err(e) => {
                        failure = Some(e.to_string());
                        session.close();
                        break;
                    }
                }
            }
            let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
            session.exited.store(true, Ordering::Release);
            session.flow.close();
            session.writer.lock().unwrap().take();
            session.master.lock().unwrap().take();
            done(code, failure);
        });
        Ok(SpawnResult {
            pid,
            shell,
            cwd: cwd.to_string_lossy().into_owned(),
        })
    }

    pub fn close(&self, id: &str) {
        if let Some(session) = self.sessions.lock().unwrap().remove(id) {
            session.close();
        }
    }

    pub fn close_all(&self) {
        for (_, session) in self.sessions.lock().unwrap().drain() {
            session.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};

    #[test]
    fn flow_blocks_at_limit_and_close_wakes_reader() {
        let flow = Arc::new(Flow::default());
        assert!(flow.reserve(MAX_PENDING));
        let (tx, rx) = mpsc::channel();
        let clone = flow.clone();
        let worker = thread::spawn(move || tx.send(clone.reserve(1)).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
        flow.close();
        assert!(!rx.recv_timeout(Duration::from_secs(1)).unwrap());
        worker.join().unwrap();
    }

    #[test]
    fn acknowledgement_releases_capacity() {
        let flow = Flow::default();
        assert!(flow.reserve(MAX_PENDING));
        flow.ack(MAX_PENDING);
        assert!(flow.reserve(4096));
    }

    #[test]
    fn independent_real_terminals_remain_alive_and_preserve_utf8() {
        let terminals = Arc::new(Terminals::default());
        let (tx, rx) = mpsc::channel();
        for id in ["first", "second"] {
            let tx = tx.clone();
            let t = terminals.clone();
            terminals
                .spawn(
                    SpawnOptions {
                        id: id.into(),
                        logical_id: id.into(),
                        cwd: "~".into(),
                        shell: if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.into(),
                        cols: 80,
                        rows: 24,
                    },
                    move |data| {
                        let _ = tx.send((id.to_string(), data.clone()));
                        t.get(id)?.flow.ack(data.len());
                        Ok(())
                    },
                    |_, _| {},
                )
                .unwrap();
        }
        // Split tokens in the input so an echoed command cannot satisfy the assertion.
        // cmd.exe avoids the terminal cursor-report handshake used by PSReadLine.
        let (first_command, second_command) = if cfg!(windows) {
            (
                "chcp 65001 >nul\rset TM_TEST_PREFIX=TM_\rset TM_TEST_SUFFIX=中文_1\recho %TM_TEST_PREFIX%%TM_TEST_SUFFIX%\r",
                "set TM_TEST_PREFIX=TM_\rset TM_TEST_SUFFIX=second_2\recho %TM_TEST_PREFIX%%TM_TEST_SUFFIX%\r",
            )
        } else {
            (
                "printf '\\nTM_%s\\n' '中文_1'\r",
                "printf '\\nTM_%s\\n' 'second_2'\r",
            )
        };
        terminals
            .get("first")
            .unwrap()
            .write(first_command.as_bytes())
            .unwrap();
        terminals
            .get("second")
            .unwrap()
            .write(second_command.as_bytes())
            .unwrap();
        let mut outputs = HashMap::<String, Vec<u8>>::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while std::time::Instant::now() < deadline {
            let Ok((id, data)) = rx.recv_timeout(Duration::from_millis(250)) else {
                continue;
            };
            outputs.entry(id).or_default().extend(data);
            if outputs
                .get("first")
                .is_some_and(|b| String::from_utf8_lossy(b).contains("TM_中文_1"))
                && outputs
                    .get("second")
                    .is_some_and(|b| String::from_utf8_lossy(b).contains("TM_second_2"))
            {
                break;
            }
        }
        let first_received = outputs
            .get("first")
            .is_some_and(|b| String::from_utf8_lossy(b).contains("TM_中文_1"));
        let second_received = outputs
            .get("second")
            .is_some_and(|b| String::from_utf8_lossy(b).contains("TM_second_2"));
        terminals.get("first").unwrap().resize(120, 40).unwrap();
        terminals.close("first");
        assert!(!terminals
            .get("second")
            .unwrap()
            .exited
            .load(Ordering::Acquire));
        terminals.close_all();
        assert!(first_received, "first PTY did not emit its UTF-8 marker");
        assert!(
            second_received,
            "second PTY did not emit its independent marker"
        );
    }
}
