# Terminal Manager

一个完全本地运行、MIT 开源的桌面终端管理器。左侧按分组管理终端，右侧显示当前终端；切换不会停止其他终端中的任务。

Rust + Tauri 2 + 原生系统 WebView + TypeScript + xterm.js + portable-pty。不使用 Electron、云服务、账号、遥测、数据库或 AI API。

## 第一版功能

- 多个独立真实 PTY / ConPTY，后台终端持续运行；切换时保留终端画面、输入状态与历史。
- 分组、重命名、多标签、名称/目录/标签搜索，后台新输出标记和响铃标记。
- 系统 Shell 配置、提示符、历史、Tab 补全、Ctrl+C、全屏终端程序、中文输入。
- 工作目录与 Shell 可单独指定；Windows 默认优先 PowerShell 7，未安装时用 Windows PowerShell；也可以指定 `cmd.exe` 或 `wsl.exe`。
- 终端内查找、字号和历史行数设置、关闭运行中终端前确认。
- 本地 CLI `tmctl`：创建、列出、切换、重命名、分组、标签、发送文本和关闭。
- 配置自动写入本地 JSON。重开应用保留终端定义，手动启动新的 Shell；**不恢复退出前的运行进程或输出历史**。

命令建议、自动补全和主题来自你的 Shell 配置（例如 zsh 插件、fish、PSReadLine），本工具不会自动安装或修改这些配置。不同平台的 IME、剪贴板和特殊按键仍需各自验收。

## 开发环境

- Node.js 26 LTS + npm（最低 Node 24）
- Rust stable、Cargo、rustfmt、Clippy
- macOS：Xcode Command Line Tools
- Windows 10/11：MSVC C++ Build Tools + Windows SDK + WebView2；使用 MSVC Rust 工具链
- Linux：WebKitGTK 4.1、C/C++ 编译工具及 Tauri 系统库。Ubuntu / Debian 示例：

```bash
sudo apt-get update
sudo apt-get install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

更多发行版见 [Tauri 官方环境要求](https://v2.tauri.app/start/prerequisites/)。macOS 上通过 Homebrew 安装 rustup 的用户，需要把 `/opt/homebrew/opt/rustup/bin` 加入 PATH。

## 启动

```bash
npm ci
npm run desktop
```

`npm run dev` 只预览界面，浏览器不能创建本机 PTY。真实终端须在 Tauri 桌面窗口中运行。

生产应用：

```bash
npm run tauri -- build
```

macOS 如只需要 `.app`，不生成 DMG：

```bash
npm run tauri -- build --bundles app
```

构建结果位于 `src-tauri/target/release/bundle/`。应用运行不依赖 Node.js 或 Rust；Linux 仍需系统 WebKitGTK，Windows 需 WebView2。Windows、macOS、Linux 原生包应分别在对应系统构建；CI 已提供三平台检查矩阵。

推送 `v*` 版本标签还会触发自动发布构建：生成 Windows x64、macOS ARM64 / Intel、Linux x64 安装包与 CLI，全部成功后创建 Release 草稿，不会自动公开发布。详见 [发布流程](docs/RELEASING.md)。

## CLI

先启动桌面应用，再构建 CLI：

```bash
cargo build --manifest-path src-tauri/Cargo.toml --release --bin tmctl
```

将 `src-tauri/target/release/tmctl`（Windows 为 `tmctl.exe`）放到 PATH，或直接用完整路径：

```bash
tmctl list
tmctl new --name "后端开发" --group "工作" --tags api,debug --cwd /path/to/project
tmctl focus <id>
tmctl start <id>
tmctl read <id> --lines 100
tmctl rename <id> "修复登录"
tmctl tag <id> api,urgent
tmctl group <id> "项目 A"
tmctl send <id> "git status" --enter
tmctl close <id>
```

`<id>` 支持完整 ID、唯一 ID 前缀或唯一终端名称；有歧义时报错。`send` 默认只输入文字，显式 `--enter` 才提交。`close` 是显式终止操作，不再弹界面确认。`new` 的默认工作目录是调用 CLI 时的目录。`list` 返回 JSON，方便脚本处理。

CLI 使用绑定 **127.0.0.1 随机端口**的本地控制接口，凭据在用户配置目录的 `control.json`，并非公网服务。Unix 配置目录权限 0700、凭据文件 0600；Windows 沿用用户配置目录 ACL。终端流不经过此接口，只通过 Tauri IPC。此接口不是网络远程管理功能。

## 快捷键

| 操作 | macOS | Windows / Linux |
|---|---|---|
| 新建终端 | Cmd+Shift+T | Ctrl+Shift+T |
| 搜索侧栏 | Cmd+K | Ctrl+Shift+K |
| 查找当前输出 | Cmd+F | Ctrl+Shift+F |
| 下一个 / 上一个终端 | Ctrl+Tab / Ctrl+Shift+Tab | 同左 |
| 复制 / 粘贴 | Cmd+C / Cmd+V | Ctrl+Shift+C / Ctrl+Shift+V |
| 插入 LF 换行 | Shift+Enter | Shift+Enter |

Ctrl+C、Ctrl+D、Ctrl+R、Tab 等交给 Shell / 当前程序。管理快捷键是上述少量例外。Shift+Enter 发送 LF；具体 AI CLI 是否接受取决于程序自身的键盘协议。

## 资源控制

- 单窗口共用一个系统 WebView；每终端一个 xterm 解析状态和一个真实 Shell，不会启动一份浏览器。
- 非当前终端 `display:none`，保留解析和缓冲，不进行可见绘制。隐藏不代表解析不耗 CPU。
- 每终端默认 3000 行回滚历史，可设为 500–10000 行。内存仍会随终端数、窗口尺寸和输出内容增长。
- 每终端最多 256 KiB 尚未确认的输出；消费完再确认，超出时阻塞 PTY 读取形成背压，不无限排队、不截断 ANSI 数据。
- 16 KiB 读取块，二进制 Tauri Channel；输出确认批量发送。空闲时 PTY 读线程阻塞等待，不轮询。
- 不启用持续光标闪烁、监控面板或后台动画；配置修改防抖写入。
- 128 个保留终端上限；CLI 本地请求大小、等待时间有上限。

所有终端继续执行，但高速输出超过消费能力时会因背压减慢；这比无限增长内存或丢失终端控制序列更可控。应用退出会关闭 PTY 并尝试终止 Shell；不是后台进程托管服务，显式脱离终端的进程不保证被清理。

## 验证

```bash
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Rust 测试覆盖独立真实 PTY、Unicode 输出、resize 和流控唤醒；前端测试覆盖标签、搜索、配置恢复、CLI 名称歧义。CI 是未来执行的配置，不代表三平台已经通过实机验证。

手动验收和性能测量见 [docs/VALIDATION.md](docs/VALIDATION.md)。
本机已验证与尚待验证的项目、资源测量限制见 [docs/STATUS.md](docs/STATUS.md)。

## 本地数据

| 平台 | 默认位置 |
|---|---|
| macOS | `~/Library/Application Support/terminal-manager/` |
| Windows | `%APPDATA%\terminal-manager\` |
| Linux | `$XDG_CONFIG_HOME/terminal-manager/`，通常为 `~/.config/terminal-manager/` |

`workspace.json` 保存名称、组、标签、Shell 和启动目录，不保存终端输出、输入或运行进程。Shell 自己的历史文件遵循现有配置。`TM_CONFIG_DIR` 可指定隔离的配置目录，桌面端与 CLI 必须使用同一值。读取损坏或不支持的配置时禁用自动保存，避免覆盖原文件。

## 许可证

MIT，见 [LICENSE](LICENSE)。依赖遵循各自的开源许可证。
