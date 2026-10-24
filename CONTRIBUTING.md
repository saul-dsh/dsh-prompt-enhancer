# 贡献指南

感谢你愿意花时间改进这个插件。

## 提 Issue 之前

先看 README 的「故障排查」一节，多数问题在那里有答案。仍然需要提 issue 时，请带上：

- 操作系统与版本（Windows 11 / macOS 15 / Ubuntu 24.04）
- dsh 版本（`dsh --version`）
- 插件版本（`package.json` 里的 `version`）
- 复现步骤：输入了什么、期望什么、实际什么
- 插件日志：控制台里 `[dsh-prompt-enhancer]` 开头的行

涉及界面问题时附截图或录屏，比文字描述快十倍。

## 提 PR 之前

1. 先开 issue 讨论。避免你写完一版，方向却不对。
2. 一个 PR 只做一件事。格式化、重构、功能混在一起没法 review。
3. 跑一遍自检：

```sh
node --check index.js
node --check client.js
```

4. 改了行为就更新 README 和 CHANGELOG。CHANGELOG 按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 分类：`新增` / `变更` / `移除` / `修复`。
5. 提交信息用 `feat:` / `fix:` / `docs:` / `refactor:` / `chore:` 前缀。

## 代码约定

- **纯 ESM**，不引入构建步骤。`index.js` 在 Node 侧跑，`client.js` 在浏览器侧跑。
- **不新增运行时依赖**。客户端只能 `require('react')` 和 `@deepseek-ai/dsh-client-ui-primitives`，其他包拿不到。
- **fail-open**。增强、改写、DOM 定位任何一步失败，都必须放行原始消息，不能把用户卡在输入框里。
- **不改用户内容**。除了增强本身，不增删改用户输入的任何字符。
- 中文注释写「为什么」，不写「是什么」。代码本身能说明是什么。

## 客户端改动特别注意

`client.js` 跑在 dsh 的 web 渲染进程里，有两类地方容易踩坑：

- **槽位**：只能注册到 `conversation.input.*` 这些公开槽位。不要直接操作 dsh 的 React 树。
- **DOM 依赖**：发送按钮靠 `[data-composer-dock]` 和 aria-label 语义定位。这类代码必须包在 try/catch 里，并且定位失败时静默降级。

## 本地联调

```sh
# 装进 dsh（web profile）
dsh plugin --profile web add /absolute/path/to/dsh-prompt-enhancer

# 桌面端
dsh plugin --profile desktop add /absolute/path/to/dsh-prompt-enhancer
```

改完 `client.js` 或 `index.js` 需要重启 dsh 才生效，客户端模块在启动时加载。

## License

提交 PR 即表示你同意以 [MIT](LICENSE) 协议授权你的贡献。
