# agy-qqbot

无需额外购买 API Key，**100% 通过官方插件规范调用本机 `agy` 原生接口**，把你电脑上的 **Google Antigravity** 变成 **24 小时常驻手机 QQ 的灵魂伴侣 + 远程全能助手**。

## 核心亮点

- **100% 官方合规，能力完全对齐本体**：零抓包、零逆向、零第三方中转，直接通过官方插件 Sidecar 与本机 `agy` CLI 原生双向流通信；Antigravity 本体具备的模型、工具、技能与本地读写能力，在 QQ 里原汁原味全都有。
- **常驻热进程池（~2 秒真人级流式秒回）**：内置常驻 `stream-json` 热进程池与四点自动预热机制，消除 CLI 冷启动延迟，顶部显示「正在输入…」后约 **2 秒**即开始逐字流式跳字回复，且电脑端全程静音无弹窗打扰。
- **多模态看图 + 语音条直读**：支持直接发送图片或引用历史图片（自动识别魔数落盘并走原生视觉通道看图），发送 QQ 语音条免打字自动识别语义自然接话。
- **灵魂人设与长期记忆自适应挂载**：支持配置 `QQBOT_MEMORY_DIR` 挂载你的个人记忆与人设工作区（自动遵循工作区 `AGENTS.md` 与全局 `GEMINI.md`，按需自适应读取 `SOUL.md`、`USER.md` 及各类长期记忆文档）；同时严格隔离私聊与群聊（群聊仅 `@` 触发，绝不挂载或泄露私人记忆目录）。
- **陪聊与后台重活无锁并行**：交代查资料、改代码、跑测试等耗时任务时，主聊天自动通过 `qqbot_delegate_task` 派生后台自主子智能体异步执行并推送报告，主聊天窗口丝毫不卡、照常秒回闲聊。
- **手机端随手换挡 & 一键热更新**：支持 `/model` 自适应简写切模型、`/think` 调思考强度、`/submodel` 分离陪聊与后台干活模型、`/compact` 浓缩长对话记忆、`/new` 开新话题，以及 **`/update` 手机端一键拉取 GitHub 更新并热重启生效**。

---

## 快速开始（0 门槛三步上手）

### 1. 环境准备

- **Node.js** `>= 20.3.0`
- 已在本机安装并登录 **Google Antigravity**（确保已安装 `agy` CLI）

### 2. 克隆与安装依赖

```bash
git clone https://github.com/Shiratsuk1/agy-qqbot.git
cd agy-qqbot
npm install
```

### 3. 绑定 QQ 机器人并启用插件

1. **扫码绑定机器人**（如果你已有 QQ 开放平台的 `QQBOT_APPID` 和 `QQBOT_SECRET`，可跳过扫码直接填进 `.env`）：

   ```bash
   npm run verify:qq
   ```

   使用手机 QQ 扫描终端二维码完成绑定（凭据自动保存在本地 `.qqbot-data/credentials.json`），发一条消息收到回复后按 `Ctrl+C` 关闭验证脚本。

2. **生成 `.env` 配置文件**：

   ```bash
   cp .env.example .env
   ```

   按需在 `.env` 中填入（默认已开启 `QQBOT_BACKEND=agy-stream` 极速流式模式）：
   - `QQBOT_MEMORY_DIR`（可选）：填入你存放 `AGENTS.md` / `SOUL.md` / `USER.md` 或长期笔记的文件夹绝对路径（多个路径用 `;` 分隔）。

3. **一键安装到本机 Antigravity 插件目录**：

   ```bash
   npm run install:plugin
   ```

4. 打开 **Antigravity → Plugins（插件管理）**，启用 **`AGY QQ Bot Bridge (antigravity-qqbot)`**，等待约 5 秒后台预热完成，即可直接在手机 QQ 开聊！

---

## QQ 快捷指令速查（私聊直发）

| 指令（含别名） | 示例 | 功能说明 |
| --- | --- | --- |
| `/model` (`/m`) | `/model` · `/model 4c` · `/model 4h xhigh` · `/model opus` | 查看模型编号列表，或用超短简写（`4c`/`4a`/`4h`/`3.8f`/`sonnet`/`opus`/`orch`）切换主对话模型 |
| `/think` (`/t`) | `/think low` (`/t l`) · `/think high` (`/t h`) · `/think xh` | 切换思考强度（`low`/`medium`/`high`/`xhigh`/`max`）并自动对齐模型档位 |
| `/submodel` (`/sm`) | `/submodel 4h high` · `/submodel auto` | 单独指定后台干活子智能体模型（实现「主聊秒回 + 后台高算力攻坚」） |
| `/compact` | `/compact` · `/compact 保留关键结论` | 原生检查点压缩当前长对话历史上下文，释放窗口并提速 |
| `/new` (`/reset`) | `/new` | 开启全新对话上下文（自动保留已选定的模型与思考强度） |
| `/status` (`/info`) | `/status` | 查看当前会话 ID、运行状态、模型档位及后台任务 |
| `/tasks` & `/cancel` (`/stop`) | `/tasks` · `/cancel subtask-1` · `/stop` | 查看或立即终止正在生成的主对话轮次 / 后台子任务 |
| `/update` (`/upgrade`) | `/update` | **一键同步更新**：自动从 GitHub `git pull` 拉取最新代码并热重启网关（完整保留个人 `.env` 与聊天记录） |
| `/help` (`/?`) | `/help` | 查看快捷指令清单 |

---

## 后续如何同步最新代码更新？

本项目的**代码仓库**与你的**个人配置/会话数据**（`.env`、`.qqbot-data/`、`~/.antigravity-qqbot/`）完全分离，更新代码绝不会冲掉你的密钥、记忆目录或聊天记录：

- **方法 A（手机 QQ 内零门槛更新）**：直接在私聊给机器人发送 `/update`，机器人会自动拉取 GitHub 最新提交并热重启生效。
- **方法 B（终端手动更新）**：在项目目录执行 `git pull && npm run install:plugin`，随后在 Antigravity 插件管理页开关一次插件即可。

---

## 环境变量说明（`.env`）

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `QQBOT_BACKEND` | `agy-stream`（`.env.example`） | 推荐使用 `agy-stream`（常驻 `agy` 热进程流式输出，无桌面提示音）；亦支持 `agentapi` |
| `QQBOT_AGY_EXE` | 自动探测 | 可选，显式指定 `agy` CLI 可执行文件路径 |
| `QQBOT_MEMORY_DIR` | 空 | **私聊专属记忆目录**（多路径用 `;` 分隔），自动挂载授权并仅在私聊开放查阅 |
| `QQBOT_WORKSPACE_DIR` | `<QQBOT_DATA_DIR>/workspace` | 机器人与会话隔离工作区根目录 |
| `QQBOT_DATA_DIR` | `~/.antigravity-qqbot` | 会话映射（`sessions.json`）、模型偏好（`preferences.json`）与日志目录 |
| `QQBOT_APPID` / `QQBOT_SECRET` | 空 | QQ 机器人凭据；留空时自动读取本地扫码缓存 |
| `QQBOT_MARKDOWN_SUPPORT` | `false` | 机器人若开通官方 Markdown 消息权限可设为 `true` |
| `QQBOT_REQUIRE_MENTION` | `true` | 群聊中是否必须 `@机器人` 才触发回复 |

## 致谢与开源协议

- 基础桥接脚手架与 QQ 网关协议设计参考 [`icywhite22/antigravity-qqbot-plugin`](https://github.com/icywhite22/antigravity-qqbot-plugin) 与 [`tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot)
- 开源协议：[MIT](./LICENSE)
