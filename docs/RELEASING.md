# 发布安装包

工作流：`.github/workflows/release.yml`（Build release draft）。

## 流程

1. 同步版本号：`package.json`、`package-lock.json`（包含根 package）、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`。
2. 提交变更，确认普通 CI 通过。
3. 创建版本标签并推送，例如：

   ```bash
   git tag -a v0.1.0 -m "Release v0.1.0"
   git push origin v0.1.0
   ```

4. 在仓库 Actions → Build release draft 查看进度。标签必须存在、指向本次检出的提交，并与所有版本文件一致；版本不匹配不会创建 Release。
5. 四个原生构建全部成功后，汇总并验证 SHA-256，自动创建 **Draft + Pre-release**；不自动公开发布。
6. 到 Releases 打开草稿，下载验证需要的安装包、补充更新说明后，点击 Publish release。

也可以在 Actions 页面手动 Run workflow，输入一个**已存在的版本标签**。这适合重试失败构建，不会在 main 上直接创建任意版本。

## 附件

| 平台 | Runner | 产物 |
|---|---|---|
| Windows x64 | Windows 2022 | NSIS `-setup.exe`、tmctl ZIP |
| macOS Apple Silicon | macOS 15 ARM64 | DMG、tmctl tar.gz |
| macOS Intel | macOS 15 Intel | DMG、tmctl tar.gz |
| Linux x64 | Ubuntu 22.04 | AppImage、DEB、tmctl tar.gz |

另附 `SHA256SUMS.txt`。每个平台的安装包与 CLI 也会保存在该次 Actions 的 Artifacts 中（14 天），便于草稿汇总前排查。

构建作业只有仓库读取权限；只有最后的草稿汇总作业使用 `contents: write`。直接使用 GitHub 自带的 `GITHUB_TOKEN`，无需配置个人访问令牌。不要从不受信任的分支手动运行发布工作流。

重跑允许替换**未公开草稿**中同名的生成附件；已经公开发布的 Release 不会被覆盖，应增加版本号并创建新标签。

## 签名和运行条件

- macOS 使用 ad-hoc 签名，没有 Apple Developer 签名和公证。
- Windows 没有发布者代码签名，运行依赖 WebView2，安装器会处理相应运行时安装。
- Linux 依赖相应系统库；AppImage 兼容性仍需在目标发行版验证。
- 构建通过不等于输入法、剪贴板、AI CLI 的所有交互都经过实机验收。

将来正式分发时，可再配置 Apple Developer / Windows 代码签名证书。当前不需要证书即可产生测试用安装包。

## 本地检查

```bash
python3 scripts/release.py validate --tag v0.1.0
python3 -m unittest discover -s tests -p 'test_release.py'
node --check scripts/publish-release.mjs
```

`validate --check-ref` 还会验证本地版本标签。collect 需要 `RELEASE_VERSION`、`RELEASE_COMMIT`、`RELEASE_TARGET`，且对应 target 的 native build 已完成。
