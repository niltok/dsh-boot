# dsh-boot

轻量的 DeepSeek Harness（`dsh`）生命周期启动器。它只做一件事：把 `dsh --profile web`
变成一个“开机自启、点图标就开、能在 Web UI 里重启”的本机服务，同时不碰你的
`cordis.patch.yml` 和 profile 配置。

打包产物内置：

- Node.js 运行时
- pnpm
- `@deepseek-ai/dsh`
- `@dsh-boot/restart-plugin`（重启插件，启动时通过 `--patch` 注入）

## 功能

| 入口 | 行为 |
| --- | --- |
| 开始菜单 / 启动台图标 | 已运行则跳过启动，直接打开 Web UI；未运行则启动后打开 |
| 开机自启 | Windows Startup 快捷方式 / macOS LaunchAgent / Linux systemd user service 或 XDG autostart |
| Web UI 重启 | 设置 → 通用设置 底部的“重启服务”按钮（不放在设置面板顶部，也不单独占一个设置分区） |
| `dsh` 命令 | 安装时写入 PATH，指向内置的 Node + dsh，用户可直接执行 `dsh web`、`dsh plugin ...` |
| 启动参数文件 | `~/.dsh/dsh-boot/startup.args`，开机自启、图标启动、Web UI 重启三条路径共用 |

## 安装

### Windows

Release 提供两个 Windows Installer（MSI）：

- `dsh-boot-<version>-win32-x64-per-user.msi`
  - 不需要管理员权限，安装到 `%LOCALAPPDATA%\Programs\dsh-boot`
  - PATH 写入 **HKCU\Environment**（只影响当前用户）
  - 自启动快捷方式写入当前用户的 Startup 文件夹
- `dsh-boot-<version>-win32-x64-per-machine.msi`
  - 需要管理员权限，安装到 `%ProgramFiles%\dsh-boot`
  - PATH 写入 **HKLM\...\Session Manager\Environment**（影响所有用户）
  - 自启动快捷方式写入公共 Startup 文件夹

两个 MSI 都创建“开始菜单 → DeepSeek Harness”图标，双击等价于
`dsh-boot launch`。环境变量更新后需要重新打开终端或重新登录。

### macOS

- **DMG**：把 `dsh-boot.app` 拖入 Applications。双击图标启动并打开 Web UI；
  第一次启动会写入当前用户的 LaunchAgent 开机自启（之后可用
  `dsh-boot autostart disable` 关闭，Homebrew 安装时 CLI 在 PATH 上）。
- **Homebrew**（仓库根目录就是标准 tap 布局 `Formula/dsh-boot.rb`）：
  ```bash
  brew tap <your-github-owner>/dsh-boot
  brew install dsh-boot
  brew services start dsh-boot   # 可选；CLI 的 autostart 也可以
  ```
  `Formula/dsh-boot.rb` 里的 `YOUR_GITHUB_OWNER`、version 和 SHA-256
  需要在发布时用 `node scripts/update-brew-formula.mjs <owner/repo> <version>`
  更新。

### Linux

Linux 发行版和包管理器太杂，dsh-boot 采用**发行版无关的自包含 tarball**，避免为
deb/rpm/pacman/nix 各维护一套生命周期脚本：

```bash
tar -xzf dsh-boot-<version>-linux-x64.tar.gz
cd dsh-boot
./install.sh                  # 默认 ~/.local/opt/dsh-boot + ~/.local/bin
# 或系统级：
sudo ./install.sh             # /opt/dsh-boot + /usr/local/bin
```

`install.sh` 默认启用开机自启：有 systemd 用 `systemctl --user`，否则回退到 XDG
autostart。卸载脚本为 `uninstall.sh`（保留 `~/.dsh` 用户数据）。

## 使用

```bash
dsh-boot launch          # 确保服务在跑，然后打开浏览器
dsh-boot start           # 启动后台 supervisor + dsh（已运行则跳过）
dsh-boot stop            # 停止
dsh-boot restart         # 重启
dsh-boot status          # 状态；--json 输出机器可读状态
dsh-boot open            # 只打开浏览器
dsh-boot autostart enable|disable|status   # Windows 管理当前用户 Startup；加 --system 管理公共 Startup（需管理员）
dsh-boot args            # 查看当前生效的启动参数
dsh-boot doctor          # 检查内置运行时
```

安装后 `dsh` 和 `pnpm` 也在 PATH 中：

```bash
dsh web --port 8080        # 用内置 dsh 手动启动（不带 supervisor）
dsh plugin --profile web add <package>
```

## 启动参数文件

路径：`~/.dsh/dsh-boot/startup.args`（`DSH_HOME` 生效时在其下）。

格式：一行一个 argv 片段；空行忽略；整行 `#` 为注释；支持单/双引号和反斜杠转义。
行内 `#` 不做注释处理，所以 URL 里的 `#` 可以原样使用。文件只接受 web app
自身的 flag；`--profile`、`--patch`、`--dump-config` 等 launcher 级 flag 会被拒绝。

```text
# 三个启动路径都会读到这个文件
--host 127.0.0.1
--port 3080
--trusted-host app.internal
```

每次“拉起 dsh 子进程”时都会重新读取该文件，因此修改后：

- 点击图标启动 → 立即生效
- 下次开机自启 → 立即生效
- Web UI 点“重启服务” → 立即生效

## 重启插件如何注入

1. 打包阶段把 `@dsh-boot/restart-plugin` 安装到内置运行时，并把它加入内置
   `@deepseek-ai/dsh` 的依赖闭包（只改内置安装树里的 `package.json`）。
2. 每次启动时，supervisor 生成
   `~/.dsh/dsh-boot/dsh-boot.patch.yml`，内容只有一行 `insert`：
   ```yaml
   - insert:
       - id: dsh-boot-restart
         name: '@dsh-boot/restart-plugin'
   ```
3. supervisor 用 `dsh --profile web --patch <生成的 overlay> ...` 启动。
4. 插件 host 半边在 dsh 自己的 web server 上注册 `/dsh-boot/presence` 和
   `/dsh-boot/restart`；`/restart` 只接受同源 POST + 自定义头（无 CORS 头，
   跨站表单/脚本无法触发），验证后转发给 supervisor 的
   `127.0.0.1:<control-port>`（带随机 token）。
5. 插件 browser 半边注册到 `settings.general.item` 槽位，因此按钮出现在
   **设置 → 通用设置**，而不是设置头部或其他位置。

用户的 `~/.dsh/cordis.patch.yml`、`~/.dsh/profiles/web/cordis.patch.yml`
和 profile `package.json` 全程不被修改。

## 架构

```
桌面图标 / 自启动 / dsh-boot start
              │
              ▼
      dsh-boot supervisor (常驻, 127.0.0.1 控制端口 + token)
              │ spawn/restart
              ▼
   dsh --profile web --patch <generated overlay> <startup.args>
              ▲
              │ POST /dsh-boot/restart (同源 + 自定义头)
      Web UI → 重启插件 → supervisor /restart
```

状态、日志和配置都位于 `~/.dsh/dsh-boot/`：

- `startup.args` — 用户启动参数
- `dsh-boot.patch.yml` — 每次启动重写的注入 patch
- `state.json` — supervisor PID、控制端口、token、web URL、boot id
- `logs/dsh.log` / `logs/dsh-boot.log`

## 开发与打包

```bash
# 只需要 Node.js >= 22（npm 用于组装运行时；pnpm 本身是运行时内置依赖）。
# dsh 含原生依赖，脚本会拒绝交叉编译：在对应平台上分别执行。
node scripts/bundle-runtime.mjs win32-x64
node scripts/bundle-runtime.mjs darwin-arm64
node scripts/bundle-runtime.mjs linux-x64

# 平台包
powershell -File scripts/wix-build.ps1 -RuntimeDir dist/runtime-win32-x64
node scripts/package-macos.mjs arm64 dist/runtime-darwin-arm64
node scripts/package-linux.mjs x64 dist/runtime-linux-x64
```

可覆盖版本：

```bash
DSH_VERSION=0.1.0-rc.6 NODE_VERSION=22.23.2 PNPM_VERSION=11.21.0 \
  node scripts/bundle-runtime.mjs linux-x64
```

GitHub Actions 在推送 `v*` tag 时自动产出：

- `dsh-boot-<version>-win32-x64-per-user.msi`
- `dsh-boot-<version>-win32-x64-per-machine.msi`
- `dsh-boot-<version>-darwin-arm64.dmg` / `-x64.dmg`
- `dsh-boot-<version>-darwin-{arm64,x64}.tar.gz`（Homebrew 用）
- `dsh-boot-<version>-linux-x64.tar.gz`（Linux 因原生依赖不做交叉编译；有 ARM runner 时可在同一脚本上直接产出 arm64）
- `SHA256SUMS`

## 安全说明

- supervisor 控制端口只绑定 `127.0.0.1`，token 随机生成，状态文件权限 0600。
- Web 重启路由无 CORS 头且要求自定义请求头，跨站请求无法通过 preflight。
- dsh 默认只绑定 `127.0.0.1`；启动参数文件的 `--host` 仍受 dsh 自身限制。
- 安装目录和 PATH 变更属于系统级动作：per-user MSI 只写 HKCU，per-machine MSI
  需要 UAC 并写 HKLM，两者不会混用。

## License

MIT
