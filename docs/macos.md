# macOS 构建与验证说明

## 来源与范围

- 上游：<https://github.com/dongpen-max/XinyunOpenBot>
- 上游基准：`826f0c5f76077514d2eacf6fbe5c88b97f6ce6fb`
- 应用版本：`0.1.34`
- 当前目标：Apple Silicon / arm64；Intel 和 Universal 未验证。
- 本仓库：<https://github.com/SvenKunkka/XinyunOpenBot-macOS>
- 许可证：MIT，保留原有版权与许可文本，见根目录 `LICENSE`。

本次公开源码，不包含本机 API 配置、聊天记录、开发日志、安装包或第三方服务凭证。

## 构建

使用 macOS、Node.js 24 或更高版本，以及 `package.json` 指定的 pnpm 10.33.0。Swift 辅助程序需要可用的 Xcode / Command Line Tools 工具链；其当前构建脚本允许缺失时跳过。

```sh
git clone https://github.com/SvenKunkka/XinyunOpenBot-macOS.git
cd XinyunOpenBot-macOS
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm package
```

`pnpm package` 构建前端与服务端、尝试编译语音辅助程序、打包更新器、暂存 Mac CUA 运行时，然后调用 electron-builder。构建产物位于 `release/`：

- `XinyunOpen-Bot-0.1.34.dmg`
- `XinyunOpen-Bot-0.1.34-arm64.zip`

应用使用 Electron 自带的 Node 运行已打包服务端。Claude、Codex 等模型 CLI 属于可选外部依赖。普通 API 接入需用户提供自己的服务地址、模型和凭证。

Swift 工具链不可用时查看构建诊断；需要强制构建成功时设置 `OMB_REQUIRE_SPEECH_HELPER=1`。请通过受支持的工具链安装或修复方式处理环境问题。本分支没有完成 Apple Developer ID 签名与公证，不宣称符合正式分发要求。

## 主要适配

- `electron/main.mjs`：macOS 中文标准菜单与 Command 快捷键。
- `server/env-path.ts`：GUI 启动环境下补充常见 CLI 安装路径，附回归测试。
- `server/drivers/claude.ts`：创建权限 broker socket 父目录，并在启动 CLI 前等待监听就绪。
- `electron/cua.mjs`、`scripts/stage-cua-sdk-mac.mjs`：暂存并加载打包后的 CUA 运行时；此改动不等于本机电脑控制已经可用。
- `scripts/build-speech.mjs`、`electron/resources/speech-helper.swift`：可选 Swift helper 构建和语言选择。
- `electron/updater.mjs`：自动更新默认关闭，避免本地适配版本被上游包覆盖。
- 测试同步上游队列与异步 handoff 的现有行为；保留已跟踪的 `dist-server` 编译产物。

## 验证记录与限制

2026-09-29，在公开源码前独立重新运行：

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| Vitest（`pnpm test` 第一阶段） | 397 通过、3 跳过、0 失败 |
| Node tests（`pnpm test:updater`） | 16 通过、0 失败 |

先前开发交付记录报告了安装、Finder 启动、配置保存、流式回复、取消生成、错误提示及重启后的持久化检查。其 API 端点为 `scripts/mock-openai-server.mjs` 提供的本地模拟服务，证明模拟服务条件下的 HTTP/SSE 和界面流程，不证明真实模型调用成功；公开前没有重新进行完整桌面验收。

以下能力仍未完成端到端验证：真实模型 API、Claude/Codex CLI 真实对话、STT/TTS、云电脑、MCP/Composio、总管任务完整流程、真实自动更新。开发交付记录还报告本机 CUA driver 存在版本冲突，本机电脑控制不能视为已验收。不同 macOS 版本及其他机器的兼容性需另行测试。

## 本地接口模拟测试

```sh
node scripts/mock-openai-server.mjs 8899
```

测试端点使用固定的模拟凭证 `test-key-123`，不是真实服务密钥。仅用于本机测试，不要作为生产服务部署。

## 更新与数据

自动更新默认关闭。现有打包配置仍保留上游更新源；正式启用前应配置维护者自己的发布源并完成下载、安装、重启测试。不要仅设置 `OMB_ENABLE_UPDATER=1` 就把更新功能视为验证通过。

应用默认数据目录沿用 `~/.openmausbot/`。API 配置、会话和日志属于个人数据，不应提交到公开仓库。
