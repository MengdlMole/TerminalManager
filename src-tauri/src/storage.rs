use fs2::FileExt;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::PathBuf,
};

pub fn config_dir() -> PathBuf {
    std::env::var_os("TM_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::config_dir()
                .unwrap_or_else(super::pty::home_dir)
                .join("terminal-manager")
        })
}

pub fn prepare() -> Result<File, String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("instance.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock_exclusive()
        .map_err(|_| "Terminal Manager 已经运行，请使用已有窗口或 tmctl".to_string())?;
    Ok(lock)
}

pub fn atomic_write(name: &str, bytes: &[u8]) -> Result<(), String> {
    let dir = config_dir();
    let path = dir.join(format!("{name}.tmp"));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(&path, dir.join(name)).map_err(|e| e.to_string())
}
