# 多客户端阶段 A 实施记录

2026-10-27：Web、macOS 调试应用和 iOS 模拟器应用已完成构建及前台连接验证。Android 按要求暂停。当前使用独立模拟 API，尚未开始阶段 B 的常驻宿主、正式认证和业务接口。

## 后续实施方向

本轮工程与验证结果保留。桌面端、iOS、Android 暂停迭代，后续以 CLI 和 Web 为主；先推进共享常驻服务与正式协议，再接入 CLI 和 Web 的业务功能。Android 未验收及原生端后续工作不作为这条主线的前置条件。

## 工程边界

| 目录 | 职责 |
| --- | --- |
| `apps/web` | React 页面，显示连接状态、发送验证消息和服务回执 |
| `apps/native/src-tauri` | Tauri 原生容器，复用 Web 构建；仅提供系统、架构和版本查询 |
| `apps/mock-api` | 仅监听本机的 HTTP 模拟服务，不加载 Agent 配置、QQ、模型或记忆 |
| `packages/contracts` | 浏览器可用的请求与响应校验 |
| `packages/client` | 共享 HTTP 调用，拒绝非本机模拟地址和非模拟服务响应 |

客户端关闭不会停止模拟服务。接口保留最多 1000 条内存回执，相同客户端和请求编号重试返回原回执，内容变化返回冲突。阶段 A 标记和来源检查用于隔离模拟接口，不属于正式设备认证。

## Web 与桌面启动

要求 Node 22.13 以上和 pnpm 10。仓库根目录执行：

```sh
pnpm install
pnpm mock:api
# 另一个终端：
pnpm web:dev
# 或启动原生桌面容器：
pnpm native:dev
```

浏览器打开 `http://127.0.0.1:1420`。模拟服务地址为 `http://127.0.0.1:4317`。页面自动查询状态、发送验证消息；连接失败可修改地址后重试。桌面构建使用内嵌页面。

```sh
pnpm web:build
pnpm native:build --debug --bundles app
pnpm typecheck
pnpm typecheck:clients
pnpm test:clients
pnpm test:web
pnpm test
```

浏览器回归使用本机 Chrome，自动启动模拟服务和 Web 预览。测试覆盖桌面与手机宽度、中文往返、断连恢复；接口测试覆盖请求校验、来源限制、幂等重试、冲突和取消信号传递。

## iOS 模拟器构建

本轮环境为 Apple Silicon、Xcode 27.1、iOS 18.6 模拟器。需要 Rust 的 `aarch64-apple-ios` 和 `aarch64-apple-ios-sim` 目标，以及 XcodeGen、libimobiledevice、CocoaPods、ios-deploy。前置条件见 [Tauri 官方说明](https://v2.tauri.app/start/prerequisites/)。

XcodeGen 放在项目 `.local-tools` 中，`scripts/clients/native.sh` 会识别该位置；也可使用系统已有版本。设备工具通过 Homebrew 安装。下载曾受网络影响，后续按命令设置 Clash 本机代理完成，没有修改全局代理。各机器应使用自己的代理端口，不将代理配置写入仓库。

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
bash scripts/clients/native.sh ios init --ci --skip-targets-install
pnpm mock:api
# 另一个终端，保持此会话运行，等待 “Opening Xcode”：
pnpm native:ios:open
# 第三个终端，列出模拟器并选择其 UDID（设备标识）：
xcrun simctl list devices available
pnpm native:ios:sim <simulator-UDID>
```

`native:ios:open` 先等待 Web 构建完成，再提供 Xcode 所需的 Tauri 构建会话。`native:ios:sim` 定向构建、安装并启动选定的模拟器应用，输出位于 `artifacts/phase-a/ios-derived/Build/Products/debug-iphonesimulator/`。验证结束后可停止构建会话；已安装应用的页面和运行不依赖该会话。

本机 `tauri ios build --target aarch64-sim` 报告缺少 Simulator SDK 27.1，但 `xcodebuild -showsdks` 可列出该 SDK，且模拟器只有 18.6 和 26.2 运行时。上述脚本直接指定已有模拟器，通过 Xcode 完成构建，保留失败日志供后续工具升级核对。

页面内嵌在应用中，无需 Vite 开发服务。`Info.ios.plist` 只为 `localhost` 和 `127.0.0.1` 配置本机 HTTP 例外；共享客户端和内容安全策略继续限制目标地址。Apple 的 IP 例外规则见 [NSExceptionDomains](https://developer.apple.com/documentation/BundleResources/Information-Property-List/NSAppTransportSecurity/NSExceptionDomains)。手机真机、签名分发和商店发布未验证。

## Android 状态

按要求暂停。已下载 Android 命令行工具；JDK、SDK、NDK 未安装完整，未完成 Android 原生工程初始化、构建或连接。共享容器、图标与工具路径检查保留，不计入验收结果。

## 本轮验证结果

| 项目 | 结果与证据，日志均在 `artifacts/phase-a/` |
| --- | --- |
| 类型检查 | 核心与客户端通过，`core-typecheck.log`、`typecheck.log` |
| Web 构建 | 通过，`web-build.log` |
| macOS 调试应用 | 构建通过，`desktop-offline-build.log`；产物在 `apps/native/src-tauri/target/debug/bundle/macos/` |
| macOS 前台连接 | 通过，界面显示 `tauri / macos`，服务记录 `macos / aarch64` 回执 |
| iOS 模拟器应用 | 构建、安装和连接通过，`ios-xcode-build.log`、`ios.png`；服务记录 `ios / aarch64` 回执 |
| Web 浏览器连接 | 3 项通过，含 1280 / 390 像素宽度与失败后恢复；`web-tests.log` 和截图 |
| 新接口回归 | 3 项通过，`client-tests.log` |
| 原有核心回归 | 337 项通过，`core-tests.log` |
| 原生页面独立运行 | Web 开发与预览端口均关闭时仍收到原生回执，`connection-evidence.json`、`mock-probes.jsonl` |
| Android | 已暂停，未验收 |

实际 iOS 截图发现的状态栏遮挡已修复，按安全区域留出顶部与横向间距。浏览器手机宽度测试与原生模拟器验证分别记录。本轮没有加入通知、凭据保存、自动更新等插件；原生桥接只验证系统信息查询。

日志、安装工具、构建输出和模拟回执均已忽略，不进入 Git；正式数据目录与核心源码未修改。团队记忆工具在本会话未提供，实施依据为当前源码、官方文档与实际工具反馈。
