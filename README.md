# dsh-prompt-enhancer

[English](README.en.md) | 简体中文

给 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)做的**对话框提示词自动增强插件**：你在对话框里随手打一句粗糙的需求，插件在消息真正发给模型之前，先调用一次轻量改写，把它变成一段清晰、具体、自包含的提示词——体验对标 WorkBuddy / ChatGPT 的「提示词增强」。

```
你输入  →  [dsh-prompt-enhancer 改写]  →  增强后的提示词进入会话  →  Agent 执行
```

## 效果示例

| 你的原始输入 | 增强后（自动进入会话） |
|---|---|
| 帮我写个爬虫 | 编写一个 Python 爬虫脚本：抓取指定网址列表中每个页面的标题和正文，按天保存为 CSV（列：url、title、content、date）。要求：请求间隔 ≥1 秒、失败自动重试 3 次、超时 10 秒，代码含中文注释并附使用说明。 |
| 这个 bug 修一下 | 定位并修复当前仓库中的构建失败：先运行 `pnpm run build` 复现报错，给出根因分析（引用具体文件与行号），完成最小修复后重新运行构建验证通过，并总结改动点。 |
| 做个网站 | 用单个 HTML 文件制作一个「个人书签导航页」：顶部搜索过滤，卡片式分组展示书签（名称、URL、备注），支持增删改（localStorage 持久化），浅色主题、移动端适配，无外部依赖。 |

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
| `provider` / `model` | 跟随会话 | 增强调用用的模型路由，建议快模型 |
| `timeoutMs` | `20000` | 超时即放弃增强（fail-open） |
| `minPromptLength` | `4` | 短于该长度不增强 |
| `maxInputChars` | `4000` | 长于该长度不增强 |
| `language` | `auto` | 输出语言 |
| `styleHint` | 空 | 自定义风格要求 |

## 工作原理

- 挂载 `agent/pre-step` 瀑布流（dsh 的**权威消息准入接缝**）：每一步开始前拿到默认裁决 `{ kind: 'enter', messages }`，把批次内的**纯文本用户消息**用一次 LLM 调用重写后，以全新 `UserMessage` 放行。
- **跳过规则**：斜杠命令（`/plan` 等）不改写；含文件/图片附件的消息不改写；过短、过长输入不改写；非聊天框来源的内部 user 消息（goal 轮次、会话引用、notice 等）不改写。
- **fail-open**：增强失败 / 超时 / 无可用路由时，原始消息原样放行，绝不阻塞对话。
- **输入框增强按钮**：web 端在输入框工具栏左侧注册一个 Sparkle 图标（`conversation.input.left` slot，对齐 WorkBuddy 的「增强提示词」图标）。点击后把当前草稿发给 `/api/prompt-enhancer/rewrite`，用改写结果替换输入框内容；草稿为空或正在请求时按钮禁用。CLI / TUI 等没有 web 客户端的宿主不加载这部分，只保留发送前自动增强。
- 同时注册 `enhance_prompt` 工具：模型自己也能调用（例如在重跑一个模糊需求前先改写它）。

## 注意事项

- dsh 目前处于 **developer preview**，插件 API 可能随版本变动；本插件已针对 `0.2.x` 的事件与类型核对，升级后如失效应先复查 `agent/pre-step` 签名。
- 每条消息发送前会**多一次模型调用**（增强调用本身消耗少量 token）；对延迟敏感时请给 `model` 配置快模型。
- 增强后的提示词会进入会话日志（与 WorkBuddy 行为一致）；想回看原始输入可在插件日志里找到 `enhanced X -> Y chars` 记录。
- 输入框的增强按钮只在 web 客户端出现；要在配置层面彻底关闭自动增强，请在 profile 里设 `enabled: false`（此时按钮也不会注册）。

## 发布到 GitHub（维护者）

1. Fork / 推送本仓库，把 `package.json` 里 `repository.url` 改成你的地址。
2. 给仓库添加 GitHub Topic：`dsh-plugin`（官方发现机制会按该 topic 收录）。
3. （可选）发布到 npm：`npm publish`，`files` 白名单已含 `index.js` 与 `cordis.patch.yml`。
4. 建议在 README 顶部放一段安装命令，方便一键复制。

## License

[MIT](LICENSE)
