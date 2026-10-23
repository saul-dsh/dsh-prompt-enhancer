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

export const name = 'prompt-enhancer'

export const inject = ['llm', 'tools']

export const Config = Schema.object({
  /** 总开关：关闭后插件完全不参与 pre-step，也不注册工具行为变化。 */
  enabled: Schema.boolean().default(true).description('是否启用自动提示词增强'),
  /** auto：每条人类消息发送前自动增强；manual：只注册 enhance_prompt 工具，不自动改写。 */
  mode: Schema.union(['auto', 'manual']).default('auto').description('auto=自动增强, manual=仅工具'),
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
/* 内置改写元提示词                                                      */
/* ------------------------------------------------------------------ */

// 与 WorkBuddy（腾讯 WorkBuddy 客户端）内置的 enhance-prompt 代理同源的改写提示词。
// 逆向自本机 WorkBuddyCN/resources/app.asar → main/server.js（agentName = 'enhance-prompt'）。
const META_RULES = [
  'You are a Prompt Engineering Expert specializing in improving user prompts for a development code assistant. When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose. The requests are being made to an AI assistant that specializes in writing code.',
  '',
  'TASK: When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose. The requests are being made to an AI assistant that specializes in writing code.',
  '',
  'ANALYSIS PROCESS:',
  'Evaluate the original prompt:',
  'Identify the main objective',
  'Note any ambiguities or gaps',
  'Assess the clarity of instructions',
  'Check for missing context',
  'Apply these prompt engineering principles:',
  'Write clear, specific instructions',
  'Include necessary context',
  'Set explicit parameters and constraints',
  'Structure the output format',
  'Add relevant examples',
  'Match tone and complexity to the use case',
  'Remove redundant information',
  'Create the enhanced version:',
  'Maintain the original goal',
  'Incorporate identified improvements',
  'Ensure clarity and completeness',
  'Be realistic in the features to add',
  'Do NOT request guides/how-tos unless the user asks',
  'Do NOT ask for code snippets',
  'Do NOT suggest specific technologies unless mentioned in the user\'s prompt',
  'Do NOT explain HOW to do things, focus on WHAT',
  'Do NOT answer questions - expand/rewrite them to be more detailed',
  'IMPORTANT CONSTRAINTS:',
  '1. Language matching is the highest priority - You MUST strictly respond in the exact same language as the user\'s input. If the user writes in Chinese, respond in Chinese; if the user writes in English, respond in English; if the user uses another language, respond in that same language. Do not mix languages unless the user\'s input itself mixes languages.',
  '2. Keep the enhanced prompt concise - maximum length should be around 800 characters',
  'FORMAT: Provide only the enhanced prompt with no additional commentary.',
  '',
  'Example:',
  '"A website for my dog"',
  '',
  'Enhanced prompt:',
  '"Design a personalized Next.js website dedicated to showcasing my dog. Include sections such as a photo gallery, a biography detailing the dog\'s breed, age, and personality traits, and a blog for sharing stories or updates about your dog\'s adventures. Add a contact form for visitors to reach out with questions or comments. Ensure the website is visually appealing and easy to navigate, with a responsive design that works well on both desktop and mobile devices."',
  '',
  'Example:',
  '"Convert this to a friendly tone, maintain technical details but reduce bullets in favor of narrative. Remove any jargon like \'genie router\'. Use canvas"',
  '',
  'Enhanced prompt:',
  '"Transform the provided content into a friendly narrative format while preserving all technical details. Minimize bullet points in favor of flowing prose. Eliminate any technical jargon such as \'genie router\'. Incorporate the concept of using canvas elements naturally within the narrative structure to enhance the technical explanation."',
].join('\n')

function buildMetaPrompt(raw, config) {
  const lines = [META_RULES]
  // WorkBuddy 的提示词已内置「跟随输入语言」；这两个配置只用于强制覆盖。
  if (config.language === 'zh') lines.push('', '7. Write the enhanced prompt in Chinese (Simplified).')
  else if (config.language === 'en') lines.push('', '7. Write the enhanced prompt in English.')
  if (config.styleHint && config.styleHint.trim().length > 0) {
    lines.push('', `Additional style requirements from the host config: ${config.styleHint.trim()}`)
  }
  lines.push('', 'Raw input:', raw)
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
  return out
}

/** 调一次 LLM 做改写；任何失败都抛错，由上层兜底放行。 */
async function rewriteWithLlm(ctx, route, raw, config, outerSignal) {
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
    messages: [{ role: 'user', content: [{ type: 'text', text: buildMetaPrompt(raw, config) }] }],
    maxTokens: 2048,
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
    const route = resolveRoute(agent) ?? lastRoute
    if (!route) return message
    const enhanced = await rewriteWithLlm(ctx, route, raw.trim(), config, signal)
    log('log', `enhanced ${raw.trim().length} -> ${enhanced.length} chars`)
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
        const enhanced = await rewriteWithLlm(ctx, route, String(args.prompt ?? '').trim(), config, exec?.signal)
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
      kind: 'exact',
      path: '/api/prompt-enhancer/rewrite',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(body))
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
        const route = endpointRoute()
        if (!route) {
          send(409, { error: 'no model route available; set provider/model in the plugin config' })
          return
        }
        try {
          const enhanced = await rewriteWithLlm(ctx, route, text, config)
          send(200, { text: enhanced })
        } catch (err) {
          log('error', `composer enhance failed: ${err?.message ?? err}`)
          send(502, { error: 'enhance-failed' })
        }
      },
    }), 'prompt-enhancer: /api/prompt-enhancer/rewrite')
  })
}

export default { name, inject, Config, apply }
