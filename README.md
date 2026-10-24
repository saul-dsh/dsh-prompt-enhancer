# dsh-prompt-enhancer

[English](README.en.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/license-MIT-3da639.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.2.3-blue.svg)](CHANGELOG.md)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.0-5b8def.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933.svg)](https://nodejs.org)
[![CI](https://github.com/saul-dsh/dsh-prompt-enhancer/actions/workflows/ci.yml/badge.svg)](https://github.com/saul-dsh/dsh-prompt-enhancer/actions)

给 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)做的**对话框提示词增强插件**：你在对话框里随手打一句粗糙的需求，插件在消息真正发给模型之前，先调用一次轻量改写，把它变成一段清晰、具体、自包含的提示词——体验对标 WorkBuddy / ChatGPT 的「提示词增强」。

<!-- 配图待补：docs/panel.png（强度面板截图） -->

```
你输入  →  点发送  →  发送按钮三点旋转  →  [dsh-prompt-enhancer 改写]  →  自动发出增强后的提示词
```

三档强度（Low / High / Max）和「发送时自动增强」开关，都挂在输入框左侧 ✨ 按钮上：鼠标停约 1.5 秒，向上弹出一个小面板。**自动增强默认关闭**，装好后先手动点 ✨ 试效果，觉得合适再打开。

## 目录

- [增强强度](#增强强度)
- [效果示例](#效果示例)
- [安装](#安装)
- [配置](#配置)
- [界面](#界面)
- [工作原理](#工作原理)
- [兼容性](#兼容性)
- [故障排查](#故障排查)
- [相关插件](#相关插件)
- [贡献](#贡献)

## 增强强度

| 档位 | 做什么 | 长度变化 | 适用场景 |
|---|---|---|---|
| **Low** | 只修歧义、指代、冗余、断句，不动结构 | ≤1.4 倍 | 随手写的一句话，只想让它通顺明确 |
| **High** | 补全目标、约束、输出形式，保留原意 | 1.3~2.2 倍 | 默认档，日常使用 |
| **Max** | 第一性原理拆解，补隐含假设并逐条标注 `(assumption: ...)`，把缺失信息写成条件要求 | 2~3.5 倍 | 复杂任务，宁可啰嗦也要一次说清 |

三档各自有独立的改写规则、token 上限和长度上限。Max 档如果失控（超过该档上限 1.6 倍）直接判失败回退原文，不会把一句话膨胀成小作文塞给你。

不想增强时不用切档位，把「发送时自动增强」开关关掉即可，发送不会被拦截；想手动改一次还是点 ✨。

## 效果示例

| 你的原始输入 | 增强后（High 档） |
|---|---|
| 帮我写个爬虫 | 编写一个 Python 爬虫脚本：抓取指定网址列表中每个页面的标题和正文，按天保存为 CSV（列：url、title、content、date）。要求：请求间隔 ≥1 秒、失败自动重试 3 次、超时 10 秒，代码含中文注释并附使用说明。 |
| 这个 bug 修一下 | 定位并修复当前仓库中的构建失败：先运行 `pnpm run build` 复现报错，给出根因分析（引用具体文件与行号），完成最小修复后重新运行构建验证通过，并总结改动点。 |
| 做个网站 | 用单个 HTML 文件制作一个「个人书签导航页」：顶部搜索过滤，卡片式分组展示书签（名称、URL、备注），支持增删改（localStorage 持久化），浅色主题、移动端适配，无外部依赖。 |

同一句「做个网站」在 Low 档只会补成「用单个 HTML 文件做一个个人书签导航页，支持搜索过滤和增删改」，在 Max 档会拆成目标 / 数据 / 交互 / 验收四段并标注「(assumption: 纯前端，无后端)」。

更多对比见 [examples/before-after.md](examples/before-after.md)。

## 安装

### 方式一：本地路径安装（开发/试用）

```sh
dsh plugin --profile web add /path/to/dsh-prompt-enhancer
dsh --profile web --dump-config   # 确认插件树里出现 prompt-enhancer
dsh --profile web
```

### 方式二：从 GitHub 安装

```sh
dsh plugin --profile web add https://github.com/saul-dsh/dsh-prompt-enhancer
```

### 方式三：不改 profile，先用 `--patch` 临时挂载试用

```sh
# scratch.cordis.yml
# - insert:
#   - id: prompt-enhancer
#     name: /absolute/path/to/dsh-prompt-enhancer/index.js

dsh --profile web --patch ./scratch.cordis.yml
```

启动日志出现 `[dsh-prompt-enhancer] loaded (mode=auto, ...)` 即安装成功。

## 配置

在 profile 配置（或 market 安装后的插件设置）里对 `prompt-enhancer` 行写 `config`：

```yaml
- override:
    id: prompt-enhancer
    config:
      enabled: true
      mode: auto            # auto=发送前自动增强；manual=只注册工具不自动改写
      level: high           # 默认强度 low/high/max；前端滑块会覆盖它。off=整条链路不增强
      preStepAuto: false    # 服务端兜底增强，默认关；开了会在你看不到的地方改消息
      # provider: deepseek-official   # 留空=跟随当前会话的模型路由
      # model: deepseek-flash         # 建议配一个快模型，降低每次发送的延迟
      timeoutMs: 20000       # 单次增强超时，超时后原样发送
      minPromptLength: 4     # 「继续」「ok」这类超短输入不增强
      maxInputChars: 4000    # 长输入视为已是完整提示词，不再增强
      language: auto         # auto=跟随输入语言；可强制 zh / en
      styleHint: ""          # 追加自定义风格要求，例如"偏工程口吻，给出验收标准"
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `mode` | `auto` | `auto` 自动增强；`manual` 仅暴露工具 |
| `level` | `high` | 默认强度；前端滑块切换后以页面选择为准。`off` 只用于配置层彻底关闭 |
| `preStepAuto` | `false` | 服务端兜底增强。默认关，因为前端拦截已经负责增强；打开后即使前端没拦到也会改消息，但用户看不到旋转提示 |
| `provider` / `model` | 跟随会话 | 增强调用用的模型路由，建议快模型 |
| `timeoutMs` | `20000` | 超时即放弃增强（fail-open） |
| `minPromptLength` | `4` | 短于该长度不增强 |
| `maxInputChars` | `4000` | 长于该长度不增强 |
| `language` | `auto` | 输出语言 |
| `styleHint` | 空 | 自定义风格要求 |

## 界面

输入框左侧一个 ✨ 按钮，强度面板挂在它上面。

- **✨ 按钮**：点一下手动增强当前草稿，改完写回输入框不发送。增强成功后按钮变成红色的撤销图标，点一下恢复原文。这个状态一直保留，直到你改动草稿或者把消息发出去。
- **悬浮面板**：鼠标停在 ✨ 上约 1.5 秒，向上弹出强度滑块（Low / High / Max）和「发送时自动增强」开关。滑块是粗轨道加大圆手柄，填充区随档位出现渐变色和从右往左流动的小光点，档位越高光点越密。选完鼠标移开自动收起，不会挡住输入框。
- **发送时自动增强**：**默认关闭**。打开后点发送按钮或按 Enter 不会立刻发出：发送按钮先变成三点旋转，增强结果写回输入框**停留约 0.7 秒**让你看清改写结果，然后才自动 submit。失败就按原文发，不会把你卡在输入框里。
- **不拦截的情况**：空草稿（纯附件发送）、斜杠命令、Shift/Ctrl/Alt+Enter、输入法组合中的回车。

## 工作原理

- **发送拦截（主路径）**：客户端在捕获阶段监听发送按钮的 click 和输入框的 Enter。命中后阻止事件到达 dsh 自己的事件根，先请求改写，把结果 `setDraft` 回输入框，再调用 `inputActions.submit()`。发送按钮期间显示三点旋转。
- **pre-step 兜底（副路径）**：挂载 `agent/pre-step` 瀑布流（dsh 的**权威消息准入接缝**），前端没拦到时把批次内的**纯文本用户消息**重写后放行。前端刚增强过的文本按指纹去重，同一句话不会被改两遍。
- **跳过规则**：斜杠命令（`/plan` 等）不改写；含文件/图片附件的消息不改写；过短、过长输入不改写；非聊天框来源的内部 user 消息（goal 轮次、会话引用、notice 等）不改写。
- **fail-open**：增强失败 / 超时 / 无可用路由 / 模型输出失控时，原始消息原样放行，绝不阻塞对话。
- **输入框增强按钮**：web 端在 `conversation.input.left` 注册 Sparkle 图标，强度面板挂在同一个按钮的悬浮上。CLI / TUI 等没有 web 客户端的宿主不加载这部分，只保留 pre-step 兜底。
- 同时注册 `enhance_prompt` 工具：模型自己也能调用（例如在重跑一个模糊需求前先改写它）。

## 兼容性

| 项目 | 要求 |
|---|---|
| dsh | ≥ 0.2.0（developer preview，已按 0.2.x 的事件与类型核对） |
| Node | ≥ 18 |
| 客户端 | web（桌面端与浏览器）。CLI / TUI 只保留 pre-step 部分，没有按钮 |
| 运行时依赖 | 无。只使用 dsh 自带的 `@deepseek-ai/*` peer 依赖 |

dsh 处于 developer preview，插件 API 会变。升级 dsh 后如果失效，先查两处：`agent/pre-step` 的签名，`[data-composer-dock]` 的结构。

每条消息发送前会**多一次模型调用**，消耗少量 token。对延迟敏感时给 `model` 配一个快模型，或用 Low 档（输出更短，回得更快）。增强后的提示词会进入会话日志，原始输入可以在控制台的 `enhanced[level] X -> Y chars` 记录里找到。

## 故障排查

**✨ 按钮不出现**

- 确认插件装在了你正在用的 profile 上：`dsh plugin --profile desktop list`
- 只在 web 客户端注册，CLI / TUI 看不到
- 草稿为空时按钮是禁用态（45% 透明度），不是消失了
- 装完没重启 dsh。客户端模块在启动时加载

**点发送没转圈，直接就发出去了**

- 「发送时自动增强」默认关闭。鼠标停在 ✨ 上，把开关打开
- 斜杠命令、纯附件消息、Shift / Ctrl / Alt + Enter 不拦截，这是设计如此
- 还不行就看 `~/.dsh/prompt-enhancer-debug.log`，每次拦截失败都会记一行现场：`autoSend` 是否开着、有没有拿到输入动作、页面上有哪些按钮

**转圈了但提示词没变**

- 增强失败会按原文发出，控制台有 `[dsh-prompt-enhancer] enhance failed`
- 最常见原因是没有模型路由。在配置里设 `provider` / `model`，或先在会话里发一条消息建立路由
- Max 档输出超过上限 1.6 倍会被判为失控，同样回退原文

**消息被改了两次**

- 检查 `preStepAuto` 是否为 `true`。默认 `false`，前端已经负责增强
- 真开了兜底也没关系，前端增强过的文本会按指纹去重，两分钟内不会重复改

**面板位置不对或跑到屏幕外**

- 面板以 ✨ 按钮为基准向上定位，只有上方空间不足时才落下方
- 窗口 resize 会自动关闭面板，重新悬停即可

**改完代码不生效**

- 客户端模块在 dsh 启动时加载，改 `client.js` 或 `index.js` 后必须重启 dsh

## 相关插件

- [dsh-siri-voice](https://github.com/saul-dsh/dsh-siri-voice) —— 同一个作者，语音输入时的 Siri 风格流光带

## 贡献

欢迎提 issue 和 PR。动手前先读 [CONTRIBUTING.md](CONTRIBUTING.md)，改动记录见 [CHANGELOG.md](CHANGELOG.md)。

## 发布到 GitHub（维护者）

1. Fork / 推送本仓库，把 `package.json` 里 `repository.url` 改成你的地址。
2. 给仓库添加 GitHub Topic：`dsh-plugin`（官方发现机制会按该 topic 收录）。
3. （可选）发布到 npm：`npm publish`，`files` 白名单已含 `index.js` 与 `cordis.patch.yml`。
4. 建议在 README 顶部放一段安装命令，方便一键复制。

## License

[MIT](LICENSE)
