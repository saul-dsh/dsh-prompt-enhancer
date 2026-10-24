# dsh-prompt-enhancer

English | [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-3da639.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.2.3-blue.svg)](CHANGELOG.md)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.0-5b8def.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933.svg)](https://nodejs.org)
[![CI](https://github.com/saul-dsh/dsh-prompt-enhancer/actions/workflows/ci.yml/badge.svg)](https://github.com/saul-dsh/dsh-prompt-enhancer/actions)

A **chat-box prompt auto-enhancement plugin** for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness). You type a rough request into the chat box; before the message reaches the model, the plugin makes one lightweight LLM call to rewrite it into a clear, specific, self-contained prompt — the same experience as the prompt enhancer in WorkBuddy / ChatGPT.

<!-- Screenshot pending: docs/panel.png (intensity panel) -->

```
your input → press send → send button shows three spinning dots → [rewrite] → enhanced prompt is sent automatically
```

Three intensity levels (Low / High / Max) plus an "auto-enhance on send" toggle, both on the ✨ button at the left of the composer: rest the cursor on it for ~1.5s and a small panel pops up. **Auto-enhance is off by default** — try the ✨ button first, turn it on when it feels right.

## Intensity levels

| Level | What it does | Length change | When to use |
|---|---|---|---|
| **Low** | Fix ambiguity, pronouns, redundancy, run-on sentences only; keep the structure | ≤1.4x | Quick one-liners that just need to be clear |
| **High** | Add goal, constraints, expected output form; preserve intent | 1.3–2.2x | Default, everyday use |
| **Max** | First-principles reconstruction; surface hidden assumptions labeled `(assumption: ...)`; turn missing info into conditional requirements | 2–3.5x | Complex tasks where being explicit pays off |

Each level has its own rule set, token budget and length ceiling. If Max output overshoots its ceiling by 1.6x it is treated as a failure and the original text is sent instead — a one-line request never turns into an essay.

To skip enhancement entirely, turn off "auto-enhance on send" instead of switching levels; sending is then not intercepted. Clicking ✨ still rewrites the draft once.

## Example

| Your raw input | What the agent actually receives (High) |
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
      level: high           # default intensity: low / high / max; the UI slider overrides it. off disables the whole chain
      preStepAuto: false    # server-side fallback, off by default; it rewrites messages invisibly
      # provider: deepseek-official   # empty = follow the session's model route
      # model: deepseek-flash         # a fast model keeps the added latency low
      timeoutMs: 20000
      minPromptLength: 4
      maxInputChars: 4000
      language: auto        # auto / zh / en
      styleHint: ""
```

## Composer UI

- **✨ button** (left): click to rewrite the current draft in place, no send. After a successful rewrite the button turns into a red undo icon — one click restores the original. It stays there until you edit the draft or send the message.
- **Hover panel**: rest the cursor on ✨ for ~1.5s and an intensity slider pops up above the composer (Low / High / Max) together with the "auto-enhance on send" toggle. Thick track, large knob, and a gradient fill with small light dots flowing right-to-left, denser as the level rises. It closes when the cursor leaves, and it opens upward so it never overflows the viewport.
- **Auto-enhance on send** (off by default): when enabled, pressing send or Enter does not send immediately. The send button turns into three spinning dots, the rewrite lands back in the composer and **stays there for about 0.7s** so you can see what changed, then `submit()` fires. On failure the original text is sent — you are never stuck in the composer.
- **Not intercepted**: empty draft (attachment-only sends), slash commands, Shift/Ctrl/Alt+Enter, and Enter during IME composition.

## How it works

- **Send interception (primary)**: the client listens in the capture phase for clicks on the send button and Enter in the composer. On a hit it stops the event before it reaches dsh's own event root, requests the rewrite, writes the result back with `setDraft`, then calls `inputActions.submit()`.
- **pre-step fallback (secondary)**: hooks the `agent/pre-step` waterfall — dsh's **authoritative message-admission seam**. Text already enhanced by the client is deduplicated by fingerprint, so a message is never rewritten twice.
- **Skipped**: slash commands (`/plan`, …), messages with file/image attachments, inputs shorter/longer than the configured bounds, and internal user-role messages that do not come from the chat box (goal rounds, session references, notices).
- **Fail-open**: on enhancement failure, timeout, missing model route, or runaway output, the original message passes through untouched.
- Also registers an `enhance_prompt` tool the model can call itself.

## Notes

- dsh is in **developer preview**; the plugin API may change between releases. This plugin targets the `0.2.x` event/type surface — re-check the `agent/pre-step` signature and the `[data-composer-dock]` structure after upgrades.
- Send interception depends on dsh's composer DOM: the send button lives in `css.composer`, while `[data-composer-dock]` only marks the bottom dock, so the container is resolved as `dock.parentElement` with a global aria-label fallback. If a dsh release breaks that, interception silently disables itself and the pre-step fallback takes over.
- When interception declines to run, a line is appended to `~/.dsh/prompt-enhancer-debug.log` with the reason (`autoSend`, whether input actions were available, visible button labels). Successful interceptions are not logged.
- Each sent message costs **one extra LLM call** (the rewrite itself). Configure a fast model, or use Low for shorter and faster output.
- The enhanced prompt is what gets logged into the session (same as WorkBuddy's behavior).

## License

[MIT](LICENSE)
