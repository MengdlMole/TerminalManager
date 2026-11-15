use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    path::PathBuf,
    time::Duration,
};

#[derive(Parser)]
#[command(version, about = "Control the running local Terminal Manager")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List terminals, metadata and runtime state as JSON
    List,
    /// Create and start a real interactive terminal
    New {
        #[arg(long, default_value = "Terminal")]
        name: String,
        #[arg(long, default_value = "默认分组")]
        group: String,
        #[arg(long, value_delimiter = ',')]
        tags: Vec<String>,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long)]
        shell: Option<String>,
    },
    Focus {
        id: String,
    },
    /// Start a saved/stopped terminal (does not restart one already running)
    Start {
        id: String,
    },
    /// Read the last N lines from the terminal's current buffer
    Read {
        id: String,
        #[arg(long, default_value_t = 100)]
        lines: usize,
    },
    Rename {
        id: String,
        name: String,
    },
    /// Replace a terminal's tags (comma separated)
    Tag {
        id: String,
        #[arg(value_delimiter = ',')]
        tags: Vec<String>,
    },
    Group {
        id: String,
        name: String,
    },
    /// Send literal text; only --enter appends a carriage return
    Send {
        id: String,
        text: String,
        #[arg(long)]
        enter: bool,
    },
    /// Terminate and remove a terminal
    Close {
        id: String,
    },
}

#[derive(Serialize, Deserialize)]
struct Endpoint {
    port: u16,
    token: String,
}

fn execute() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let dir = std::env::var_os("TM_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::config_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("terminal-manager")
        });
    let endpoint: Endpoint = serde_json::from_slice(
        &std::fs::read(dir.join("control.json"))
            .map_err(|_| "请先启动 Terminal Manager 桌面应用")?,
    )?;
    let (action, args) = match cli.command {
        Command::List => ("list", json!({})),
        Command::New {
            name,
            group,
            tags,
            cwd,
            shell,
        } => {
            let cwd = cwd.unwrap_or(std::env::current_dir()?);
            let cwd = if cwd.is_absolute() {
                cwd
            } else {
                std::env::current_dir()?.join(cwd)
            };
            (
                "new",
                json!({"name":name,"group":group,"tags":tags,"cwd":cwd,"shell":shell}),
            )
        }
        Command::Focus { id } => ("focus", json!({"id":id})),
        Command::Start { id } => ("start", json!({"id":id})),
        Command::Read { id, lines } => ("read", json!({"id":id,"lines":lines.clamp(1,1000)})),
        Command::Rename { id, name } => ("rename", json!({"id":id,"name":name})),
        Command::Tag { id, tags } => ("tag", json!({"id":id,"tags":tags})),
        Command::Group { id, name } => ("group", json!({"id":id,"name":name})),
        Command::Send { id, text, enter } => ("send", json!({"id":id,"text":text,"enter":enter})),
        Command::Close { id } => ("close", json!({"id":id})),
    };
    let mut stream = TcpStream::connect_timeout(
        &([127, 0, 0, 1], endpoint.port).into(),
        Duration::from_secs(2),
    )?;
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    let mut request =
        serde_json::to_vec(&json!({"token":endpoint.token,"action":action,"args":args}))?;
    if request.len() > 1024 * 1024 - 1 {
        return Err("请求超过 1 MiB".into());
    }
    request.push(b'\n');
    stream.write_all(&request)?;
    let mut response = String::new();
    BufReader::new(stream).read_line(&mut response)?;
    let response: Value = serde_json::from_str(&response)?;
    if let Some(error) = response.get("error") {
        return Err(error.to_string().into());
    }
    println!("{}", serde_json::to_string_pretty(&response)?);
    Ok(())
}

fn main() {
    if let Err(error) = execute() {
        eprintln!("tmctl: {error}");
        std::process::exit(1);
    }
}
