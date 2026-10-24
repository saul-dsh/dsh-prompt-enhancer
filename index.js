/**
 * dsh-prompt-enhancer — 对话框提示词自动增强插件（DeepSeek Harness / dsh）
 *
 * 工作原理：
 *   挂载 `agent/pre-step` 瀑布流。每一步开始前，dsh 会把「即将进入本轮的
 *   用户消息批次」交给所有 pre-step 监听器裁决（PreStepDecision）。本插件
 *   在拿到默认裁决（kind === 'enter'）后，把批次里的纯文本用户消息先发给
 *   一次轻量模型调用，重写成清晰、具体、自包含的提示词，再放行进入会话——
 *   即 WorkBuddy / ChatGPT 风格的「发送前提示词增强」。
 *
 * 安全设计（fail-open）：
 *   增强调用失败、超时、找不到模型路由时，一律原样放行原始消息，
 *   绝不阻塞用户的正常对话。
 *
 * 已核对的 dsh API（deepseek-ai/deepseek-harness，developer preview）：
 *   - PreStepDecision = { kind: 'reject' } | { kind: 'enter', messages: UserMessage[], startsRequestSeries?: true }
 *   - ctx.on('agent/pre-step', async ({ agent }, next) => PreStepDecision)
 *   - ctx.llm.stream({ provider, model, messages }) → AsyncIterable<StreamChunk>
 *     （文本块为 { type: 'text-delta', text }；终帧为 { type: 'finish', reason }）
 *   - createUserMessage({ content, source }) 来自 '@deepseek-ai/dsh-llm'
 *   - defineTool(...) 来自 '@deepseek-ai/dsh-tools'；服务名 'llm' / 'tools'
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 排查日志：客户端把拦截决策写到这里，出问题时直接看文件。 */
const DEBUG_LOG = join(homedir(), '.dsh', 'prompt-enhancer-debug.log')

export const name = 'prompt-enhancer'

export const inject = ['llm', 'tools']

export const Config = Schema.object({
  /** 总开关：关闭后插件完全不参与 pre-step，也不注册工具行为变化。 */
  enabled: Schema.boolean().default(true).description('是否启用自动提示词增强'),
  /** auto：每条人类消息发送前自动增强；manual：只注册 enhance_prompt 工具，不自动改写。 */
  mode: Schema.union(['auto', 'manual']).default('auto').description('auto=自动增强, manual=仅工具'),
  /** 默认增强强度；前端选择器会覆盖它。off 表示默认不增强。 */
  level: Schema.union(['off', 'low', 'high', 'max']).default('high').description('默认增强强度：off/low/high/max'),
  /**
   * pre-step 兜底增强。默认关闭：前端拦截路径已经负责增强，服务端再动一次
   * 会让「自动增强关闭」失效（用户看不到，消息却被改了）。
   * 只有当前端拦截失效、又确实想要兜底时才手动打开。
   */
  preStepAuto: Schema.boolean().default(false).description('是否在 pre-step 兜底自动增强（默认关闭，前端已负责增强）'),
  /** 留空则跟随当前会话 Agent 的 provider 路由。 */
  provider: Schema.string().description('增强调用使用的 provider（留空跟随会话）'),
  /** 留空则跟随当前会话 Agent 的 model。建议配一个快模型降低延迟。 */
  model: Schema.string().description('增强调用使用的模型（留空跟随会话，建议快模型）'),
  /** 单次增强调用的超时时间，超时即放弃增强、原样放行。 */
  timeoutMs: Schema.number().default(20000).description('增强调用超时（毫秒）'),
  /** 短于该长度（字符）的输入不做增强（如「继续」「ok」）。 */
  minPromptLength: Schema.number().default(4).description('触发增强的最小输入长度（字符）'),
  /** 超过该长度的输入视为已经是完整提示词，不再增强。 */
  maxInputChars: Schema.number().default(4000).description('超过此长度不再增强（字符）'),
  /** 增强后提示词的语言：auto=跟随原始输入。 */
  language: Schema.union(['auto', 'zh', 'en']).default('auto').description('输出语言'),
  /** 追加到内置改写规则之后的自定义风格要求（可为空）。 */
  styleHint: Schema.string().default('').description('自定义风格要求（追加到改写规则后）'),
})

/* ------------------------------------------------------------------ */
/* 增强强度分级                                                         */
/* ------------------------------------------------------------------ */

/**
 * 四档强度的差异不在「想得多深」，而在「改多少、补多少、要不要改结构」。
 * 每档给独立的规则、token 上限和长度上限，避免 Max 档把一句话膨胀成论文。
 */
const LEVELS = {
  off: null,
  low: {
    label: 'Low',
    maxTokens: 900,
    maxRatio: 1.4,
    rules: [
      'INTENSITY: LOW (minimal edit).',
      'Change only what is necessary to remove ambiguity. Keep the original wording, tone and length as much as possible.',
      'Do: fix vague pronouns, unclear verbs, missing objects, redundancy, obvious typos. Split run-on sentences.',
      'Do NOT: add new sections, add headings, invent requirements, add constraints the user did not imply, expand into a spec.',
      'Target length: at most 1.4x the original. Shorter is better.',
      'If the input is already clear, return it almost unchanged.',
    ],
  },
  high: {
    label: 'High',
    maxTokens: 1800,
    maxRatio: 2.2,
    rules: [
      'INTENSITY: HIGH (structured completion).',
      'Rewrite into a clear, self-contained, directly executable request. Add the context, constraints and output expectation that a competent assistant would need.',
      'Do: state the goal explicitly, make implicit requirements explicit, specify the expected output form, keep the user\'s intent and scope.',
      'Do NOT: invent facts, technologies, file names or numbers the user never mentioned. When a detail is genuinely unknown, express it conditionally ("if X, then Y") or mark a default as "(default: ...)".',
      'Do NOT: reply with "please confirm these details first" or ask the user anything. That converts the prompt into a conversation. Fill the gap yourself and keep the request executable.',
      'Do NOT: turn the request into a tutorial, a plan, or an answer. It must stay a request.',
      'Prefer flowing paragraphs over markdown headings unless the task is clearly multi-part.',
      'Target length: 1.3x to 2.2x the original. For very short inputs (under 20 characters), 2-4x is fine — a bare phrase needs more scaffolding than a half-written spec.',
    ],
  },
  max: {
    label: 'Max',
    maxTokens: 3200,
    maxRatio: 3.5,
    rules: [
      'INTENSITY: MAX (first-principles reconstruction).',
      'First reason about what outcome the user actually wants, then rebuild the request from that outcome rather than patching the wording.',
      'Do: decompose into goal, context, constraints, deliverables, acceptance criteria when the task warrants it; surface hidden assumptions and mark each one inline as "(assumption: ...)"; make success verifiable.',
      'Do: point out missing critical information as conditional requirements inside the prompt, never as a question back to the user.',
      'Do NOT: invent facts. Every assumption must be labeled.',
      'Do NOT: pad with generic prompt-engineering boilerplate ("You are a world-class expert..."), role-play scaffolding, or restated instructions.',
      'FORMAT: plain text only, because the output lands in a plain-text composer. No "#" headings, no "**bold**", no "-" or "*" bullets, no code fences.',
      'Structure with short labeled lines instead: 目标：/ 背景：/ 约束：/ 产出：/ 验收： (or Goal:/Context:/Constraints:/Deliverables: when writing English). One requirement per line, sub-points indented with two spaces.',
      'Target length: 2x to 3.5x the original. Never exceed 3500 characters.',
    ],
  },
}

/* ------------------------------------------------------------------ */
/* 内置改写元提示词                                                      */
/* ------------------------------------------------------------------ */

// 基础规则来自 WorkBuddy 客户端内置的 enhance-prompt 代理（逆向自 app.asar，
// agentName = 'enhance-prompt'），改写为通用 agent 场景，并按强度分级。
const BASE_RULES = [
  'You are a Prompt Engineering Expert. You rewrite a user\'s rough input into a more effective prompt for an AI assistant that can read files, run commands and write code.',
  '',
  'CORE PRINCIPLES:',
  '- Preserve the user\'s original intent and scope. You are rewriting a request, not answering it.',
  '- Never fabricate specifics the user did not provide: no invented tech stack, file paths, numbers, names, or requirements.',
  '- Keep the output in the exact same language as the input. If the input mixes languages, keep the mix.',
  '- Remove redundancy, resolve ambiguity, make the ask actionable.',
  '- Do NOT explain HOW to do the task, do NOT answer the question, do NOT add a preamble like "Here is the enhanced prompt".',
  '- Do NOT request guides, tutorials, or code snippets unless the user asked for them.',
  '- Do NOT suggest specific technologies unless they appear in the input.',
  '',
  'MISSING INFORMATION — the most important rule:',
  '- NEVER turn a gap into a question for the user. You are writing a prompt that gets executed immediately, not starting a conversation. Output containing "please confirm...", "请先确认...", "我需要知道..." is a failure.',
  '- Handle a gap in one of two ways: state a reasonable default inline as "(default: ...)", or phrase it as a conditional requirement inside the prompt ("if the site requires login, ...").',
  '- Prefer filling in generally applicable constraints (runnable output, dependencies, error handling, acceptance criteria) over interrogating the user about specifics.',
  '- The rewritten prompt must be executable as-is. Whoever reads it should be able to start working without replying first.',
  '',
  'OUTPUT: only the rewritten prompt text. No commentary, no code fences, no quotes around it.',
].join('\n')

function buildMetaPrompt(raw, config, level) {
  const spec = LEVELS[level] ?? LEVELS.high
  const lines = [BASE_RULES, '', spec.rules.join('\n')]
  // WorkBuddy 的提示词已内置「跟随输入语言」；这两个配置只用于强制覆盖。
  if (config.language === 'zh') lines.push('', 'OVERRIDE: write the rewritten prompt in Simplified Chinese.')
  else if (config.language === 'en') lines.push('', 'OVERRIDE: write the rewritten prompt in English.')
  if (config.styleHint && config.styleHint.trim().length > 0) {
    lines.push('', `Additional style requirements from the host config: ${config.styleHint.trim()}`)
  }
  // 用标签包住原文：即使原文本身长得像指令，也不会和改写规则混在一起。
  lines.push('', 'Raw input:', '<original_prompt>', raw, '</original_prompt>')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 提取消息里的纯文本内容；非「聊天框用户消息 / 单个文本块」返回 null（不处理）。 */
function singleTextOf(message) {
  if (!message || message.role !== 'user') return null
  // dsh 内部还会产生 role 为 user、source.kind 为 goal / session-reference /
  // notice 等的消息；它们不是用户在对话框里输入的内容，绝不能改写。
  if (message.source?.kind !== 'user') return null
  if (!Array.isArray(message.content)) return null
  if (message.content.length !== 1) return null
  const block = message.content[0]
  return block && block.type === 'text' && typeof block.text === 'string' ? block.text : null
}

/** 判断是否应该跳过增强。 */
function shouldSkip(text, config) {
  if (!text) return true
  const trimmed = text.trim()
  if (trimmed.length === 0) return true
  // 斜杠命令（/plan、/goal 等）绝不改写
  if (trimmed.startsWith('/')) return true
  if (trimmed.length < config.minPromptLength) return true
  if (trimmed.length > config.maxInputChars) return true
  return false
}

/** 去掉模型输出里常见的包裹物：代码围栏、引号、前缀说明行。 */
function cleanModelOutput(text) {
  let out = String(text ?? '').trim()
  // 去掉成对代码围栏 ```...```（含语言标注）
  const fence = out.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/)
  if (fence) out = fence[1].trim()
  // 去掉「增强后提示词：」「Enhanced prompt:」之类前缀行
  out = out.replace(/^(?:enhanced prompt|提示词增强|增强后的提示词|改写后(?:的提示词)?)\s*[:：]\s*/i, '')
  // 去掉最外层成对引号
  const q = out.match(/^"([\s\S]*)"$|^“([\s\S]*)”$/)
  if (q) out = (q[1] ?? q[2]).trim()
  // 兜底去 markdown：输入框是纯文本，留着 # 和 ** 只会变成噪音
  out = out
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^(\s*)[-*]\s+/gm, '$1· ')
  return out
}

/** 调一次 LLM 做改写；任何失败都抛错，由上层兜底放行。 */
async function rewriteWithLlm(ctx, route, raw, config, level, outerSignal) {
  const spec = LEVELS[level] ?? LEVELS.high
  // 超时与外部取消（用户中断 pre-step）收敛到同一个内部 signal，
  // 底层流会被及时中断，不会在后台继续烧 token。
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(outerSignal.reason)
  if (outerSignal?.aborted) forwardAbort()
  else outerSignal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new Error('prompt-enhancer timeout')),
    config.timeoutMs,
  )

  const aborted = new Promise((_, reject) => {
    const fail = () => reject(controller.signal.reason ?? new Error('prompt-enhancer aborted'))
    // 外层 signal 可能一开始就已 abort：先检查，再挂监听。
    if (controller.signal.aborted) fail()
    else controller.signal.addEventListener('abort', fail, { once: true })
  })
  // 成功路径下 aborted 不会被消费，挂空 catch 避免 unhandled rejection。
  void aborted.catch(() => {})

  const iterator = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: buildMetaPrompt(raw, config, level) }] }],
    maxTokens: spec.maxTokens,
    signal: controller.signal,
  })[Symbol.asyncIterator]()

  async function collect() {
    let text = ''
    for (;;) {
      const { done, value } = await iterator.next()
      if (done) break
      if (value.type === 'text-delta') text += value.text
      else if (value.type === 'finish' && value.reason && (value.reason.kind === 'error' || value.reason.kind === 'aborted')) {
        throw new Error(`prompt-enhancer llm ${value.reason.kind}: ${value.reason.failure?.message ?? 'unknown'}`)
      }
    }
    return text
  }

  try {
    const collected = await Promise.race([collect(), aborted])
    const cleaned = cleanModelOutput(collected)
    if (!cleaned) throw new Error('prompt-enhancer got empty output')
    // 失控保护：模型把一句话膨胀成小作文时判失败，回退原文而不是塞给用户。
    // 短输入天然膨胀率高（12 字补成 300 字是合理的），所以保底 600 字；
    // 长输入按倍数算，但封顶 4000 字，避免 4000 字输入算出 2 万字上限。
    const limit = Math.min(Math.max(Math.round(raw.length * spec.maxRatio * 1.6), 600), 4000)
    if (cleaned.length > limit) {
      throw new Error(`prompt-enhancer output runaway: ${cleaned.length} chars > ${limit}`)
    }
    return cleaned
  } catch (err) {
    // 中断底层流，避免失败后还在后台烧 token。
    // 不 await：底层若卡死，等待 return() 会拖住 fail-open。
    try {
      const closing = iterator.return?.()
      if (closing && typeof closing.catch === 'function') closing.catch(() => {})
    } catch { /* ignore */ }
    throw err
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', forwardAbort)
  }
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const log = (level, msg) => console[level === 'error' ? 'error' : 'log'](`[dsh-prompt-enhancer] ${msg}`)

  /** 最近一次见到的会话路由，供 enhance_prompt 工具和 web 端点在没有显式配置时复用。 */
  let lastRoute = null

  /**
   * 运行时增强强度。前端选择器通过 /api/prompt-enhancer/settings 改这里，
   * 让 pre-step 与手动按钮共用同一档位。初始值来自配置。
   */
  let currentLevel = Object.prototype.hasOwnProperty.call(LEVELS, config.level) ? config.level : 'high'

  /**
   * 前端刚增强过的文本指纹。发送拦截路径增强完再 submit 时，pre-step 会再看到
   * 这条消息；用它去重，避免同一句话被改两遍。两分钟自动过期。
   */
  const recentEnhanced = new Map()
  const DEDUPE_TTL = 120_000

  function fingerprint(text) {
    let h = 0
    for (let i = 0; i < text.length; i++) {
      h = (h * 31 + text.charCodeAt(i)) | 0
    }
    return `${text.length}:${h}`
  }

  function rememberEnhanced(text) {
    const now = Date.now()
    for (const [key, ts] of recentEnhanced) {
      if (now - ts > DEDUPE_TTL) recentEnhanced.delete(key)
    }
    recentEnhanced.set(fingerprint(text), now)
  }

  function wasJustEnhanced(text) {
    const ts = recentEnhanced.get(fingerprint(text))
    return ts !== undefined && Date.now() - ts < DEDUPE_TTL
  }

  /**
   * 全局默认模型选择（composer 里的模型选择器改的就是它），
   * 让输入框按钮在「会话还没创建、没有 agent」时也能拿到路由。
   */
  function defaultRoute() {
    const defaults = ctx.get('agentDefaultModel')
    const selection = defaults?.currentSelection?.()
    return selection?.provider && selection?.model
      ? { provider: selection.provider, model: selection.model }
      : null
  }

  /** 配置里显式指定的路由。 */
  function configRoute() {
    return config.provider && config.model ? { provider: config.provider, model: config.model } : null
  }

  function resolveRoute(agent) {
    const provider = agent?.options?.provider
    const model = agent?.options?.model
    return configRoute()
      ?? (provider && model ? { provider, model } : null)
      ?? defaultRoute()
  }

  /** web 端点没有 agent：配置 > 最近一次会话路由 > 全局默认选择。 */
  function endpointRoute() {
    return configRoute() ?? lastRoute ?? defaultRoute()
  }

  // 会话一建立就记住路由，这样输入框按钮在「还没发过消息」时也能工作。
  ctx.on('agent/created', ({ agent }) => {
    const route = resolveRoute(agent)
    if (route) lastRoute = route
  })

  /** 对单条消息做增强；不需要增强时原样返回同一个对象。 */
  async function enhanceOne(message, agent, signal) {
    const raw = singleTextOf(message)
    if (raw === null || shouldSkip(raw, config)) return message
    // 前端发送拦截路径已经增强过，这里放行，避免二次改写。
    if (wasJustEnhanced(raw.trim())) return message
    const level = currentLevel
    if (!level || level === 'off') return message
    const route = resolveRoute(agent) ?? lastRoute
    if (!route) return message
    const enhanced = await rewriteWithLlm(ctx, route, raw.trim(), config, level, signal)
    log('log', `enhanced[${level}] ${raw.trim().length} -> ${enhanced.length} chars`)
    // 用官方工厂重建消息：获得全新稳定 id，source 沿用原消息
    return createUserMessage({
      content: [{ type: 'text', text: enhanced }],
      source: message.source,
    })
  }

  /** 批量增强；没有任何改动时原样返回原数组。 */
  async function enhanceBatch(messages, agent, signal) {
    const out = []
    let changed = false
    for (const message of messages) {
      let next = message
      try {
        next = await enhanceOne(message, agent, signal)
      } catch (err) {
        // fail-open：增强失败绝不阻塞对话
        log('error', `enhance failed, pass through original: ${err?.message ?? err}`)
        next = message
      }
      if (next !== message) changed = true
      out.push(next)
    }
    return changed ? out : messages
  }

  if (config.enabled) {
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      const route = resolveRoute(agent)
      if (route) lastRoute = route
      if (config.mode !== 'auto') return decision
      // 前端拦截发送并自行增强时，这里不再二次增强（否则同一句话被改两遍）。
      if (!config.preStepAuto) return decision
      const messages = await enhanceBatch(decision.messages, agent, signal)
      if (messages === decision.messages) return decision
      // spread 保留未来新增的 decision 字段
      return { ...decision, messages }
    })

    // 注册模型可调用的工具：agent 自己也能主动增强某段提示词
    ctx.tools.register(defineTool({
      name: 'enhance_prompt',
      description: [
        'Rewrite a rough user prompt into a clear, specific, self-contained prompt before using it.',
        'Use it when the user asks to improve/expand their prompt, or before re-running a vague earlier request.',
      ].join(' '),
      parameters: {
        prompt: { type: 'string', required: true, description: 'The raw prompt text to enhance' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const route = endpointRoute()
        if (!route) throw new Error('No model route available: set provider/model in the plugin config.')
        const level = currentLevel === 'off' ? 'high' : currentLevel
        const enhanced = await rewriteWithLlm(ctx, route, String(args.prompt ?? '').trim(), config, level, exec?.signal)
        return enhanced
      },
    }))

    log('log', `loaded (mode=${config.mode}, timeout=${config.timeoutMs}ms)`)
  } else {
    log('log', 'loaded but disabled by config')
  }

  /* ------------------------------------------------------------------ */
  /* web 端「增强提示词」端点（只在有 webServer 的宿主里注册）              */
  /* ------------------------------------------------------------------ */

  // 可选注入：CLI / TUI 等没有 webServer 的宿主照常加载，只是没有输入框按钮。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/api/prompt-enhancer',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(body))
        }
        const path = (req.url ?? '').split('?')[0].replace(/^\/api\/prompt-enhancer/, '')

        // 前端初始化：读当前档位，避免刷新后选择器回落到默认值。
        if (path === '/settings' && req.method === 'GET') {
          send(200, { level: currentLevel, levels: Object.keys(LEVELS) })
          return
        }

        // 前端改档位：写进运行时状态，让 pre-step 与按钮共用同一档。
        if (path === '/settings' && req.method === 'POST') {
          let raw = ''
          for await (const chunk of req) raw += chunk
          let body
          try {
            body = JSON.parse(raw)
          } catch {
            send(400, { error: 'invalid-json' })
            return
          }
          const next = body?.level
          if (typeof next !== 'string' || !(next in LEVELS)) {
            send(400, { error: `level must be one of ${Object.keys(LEVELS).join('/')}` })
            return
          }
          currentLevel = next
          log('log', `level -> ${next}`)
          send(200, { level: currentLevel })
          return
        }

        // 前端把拦截决策写进 ~/.dsh/prompt-enhancer-debug.log，排查用。
        if (path === '/debug' && req.method === 'POST') {
          let raw = ''
          for await (const chunk of req) raw += chunk
          try {
            await mkdir(dirname(DEBUG_LOG), { recursive: true })
            await appendFile(DEBUG_LOG, `${new Date().toISOString()} ${raw}\n`, 'utf8')
          } catch (err) {
            log('error', `debug log failed: ${err?.message ?? err}`)
          }
          send(200, { ok: true })
          return
        }

        if (path !== '/rewrite') {
          send(404, { error: 'not-found' })
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          send(405, { error: 'method-not-allowed' })
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let body
        try {
          body = JSON.parse(raw)
        } catch {
          send(400, { error: 'invalid-json' })
          return
        }
        const text = typeof body?.text === 'string' ? body.text.trim() : ''
        if (text.length === 0) {
          send(400, { error: 'text must be a non-empty string' })
          return
        }
        if (text.length > config.maxInputChars) {
          send(413, { error: `text exceeds ${config.maxInputChars} chars` })
          return
        }
        // 单次请求可以覆盖档位（发送拦截路径会带上当前选择），否则用运行时档位。
        const requested = typeof body?.level === 'string' && body.level in LEVELS ? body.level : currentLevel
        const level = requested === 'off' ? null : requested
        if (!level) {
          send(200, { text, skipped: 'level-off' })
          return
        }
        const route = endpointRoute()
        if (!route) {
          send(409, { error: 'no model route available; set provider/model in the plugin config' })
          return
        }
        try {
          const enhanced = await rewriteWithLlm(ctx, route, text, config, level)
          // 记下指纹：这条文本随后经 submit 进入 pre-step 时不再二次增强。
          rememberEnhanced(enhanced)
          send(200, { text: enhanced, level })
        } catch (err) {
          log('error', `composer enhance failed: ${err?.message ?? err}`)
          send(502, { error: 'enhance-failed' })
        }
      },
    }), 'prompt-enhancer: /api/prompt-enhancer/*')
  })
}

export default { name, inject, Config, apply }
