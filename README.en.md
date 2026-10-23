# dsh-prompt-enhancer

English | [简体中文](README.md)

A **chat-box prompt auto-enhancement plugin** for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness). You type a rough request into the chat box; before the message reaches the model, the plugin makes one lightweight LLM call to rewrite it into a clear, specific, self-contained prompt — the same experience as the prompt enhancer in WorkBuddy / ChatGPT.

```
your input → [dsh-prompt-enhancer rewrite] → enhanced prompt enters the session → agent runs
```

## Example

| Your raw input | What the agent actually receives |
|---|---|
| write a crawler | Write a Python crawler script: fetch the title and main text of each page in a given URL list, save daily to CSV (columns: url, title, content, date). Requirements: ≥1s delay between requests, 3 automatic retries, 10s timeout, Chinese comments, and a usage guide. |
| fix this bug | Locate and fix the current build failure: first run `pnpm run build` to reproduce the error, provide a root-cause analysis citing exact files and lines, apply the minimal fix, re-run the build to verify, and summarize the changes. |

## Install

```sh
# Local path (development)
dsh plugin --profile web add /path/to/dsh-prompt-enhancer

# From GitHub
dsh plugin --profile web add https://github.com/saul-dsh/dsh-prompt-enhancer

# Or mount temporarily without touching your profile
dsh --profile web --patch ./scratch.cordis.yml
```

On success, the startup log prints `[dsh-prompt-enhancer] loaded (mode=auto, ...)`.

## Configuration

```yaml
- override:
    id: prompt-enhancer
    config:
      enabled: true
      mode: auto            # auto = rewrite before sending; manual = expose tool only
      # provider: deepseek-official   # empty = follow the session's model route
      # model: deepseek-flash         # a fast model keeps the added latency low
      timeoutMs: 20000
      minPromptLength: 4
      maxInputChars: 4000
      language: auto        # auto / zh / en
      styleHint: ""
```

## How it works

- Hooks the `agent/pre-step` waterfall — dsh's **authoritative message-admission seam**. When the default decision is `{ kind: 'enter', messages }`, plain-text user messages in the batch are rewritten via one LLM call and re-admitted as fresh `UserMessage`s.
- **Skipped**: slash commands (`/plan`, …), messages with file/image attachments, inputs shorter/longer than the configured bounds, and internal user-role messages that do not come from the chat box (goal rounds, session references, notices).
- **Fail-open**: on enhancement failure, timeout, or missing model route, the original message passes through untouched.
- **Composer enhance button**: on web, a Sparkle icon is registered at `conversation.input.left` (the same icon as WorkBuddy's prompt enhancer). Clicking sends the current draft to `/api/prompt-enhancer/rewrite` and replaces the composer text with the rewritten prompt; the button is disabled while the draft is empty or a request is in flight. Hosts without a web client (CLI/TUI) skip this part.
- Also registers an `enhance_prompt` tool the model can call itself.

## Notes

- dsh is in **developer preview**; the plugin API may change between releases. This plugin targets the `0.2.x` event/type surface — re-check the `agent/pre-step` signature after upgrades.
- Each sent message costs **one extra LLM call** (the rewrite itself). Configure a fast model for lower latency.
- The enhanced prompt is what gets logged into the session (same as WorkBuddy's behavior).

## License

[MIT](LICENSE)
