/**
 * dsh-prompt-enhancer 的 web 客户端部分。
 *
 * 交付形态遵循 dsh 的客户端插件协议：一个 ESM 文件，调用
 * `window.__ModuleLoader__.load({ id, factory(require) })`，返回 cordis 插件对象。
 * 这里只做一件事：在输入框左侧放一个 Sparkle 图标按钮，点击切换服务端插件的
 * 运行时开关（通过 `/api/prompt-enhancer/state` 端点）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-enhancer',
  factory(require) {
    const React = require('react')
    const { Button, IconSparkleRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const ENDPOINT = '/api/prompt-enhancer/state'

    async function readState(signal) {
      const res = await fetch(ENDPOINT, { headers: { accept: 'application/json' }, signal })
      if (!res.ok) throw new Error(`prompt-enhancer state ${res.status}`)
      return res.json()
    }

    async function writeState(enabled) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) throw new Error(`prompt-enhancer toggle ${res.status}`)
      return res.json()
    }

    /** 输入框左侧的开关按钮。state 为 null 表示还没有读到服务端状态。 */
    function EnhanceToggle() {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        const controller = new AbortController()
        readState(controller.signal).then(setState).catch(() => {
          if (!controller.signal.aborted) setState({ enabled: false, configEnabled: false })
        })
        return () => controller.abort()
      }, [])

      const enabled = state?.enabled === true
      const locked = state !== null && state.configEnabled === false
      const label = state === null
        ? '提示词增强：读取中'
        : locked
          ? '提示词增强：已在配置中禁用'
          : enabled
            ? '提示词增强：已开启（点击关闭）'
            : '提示词增强：已关闭（点击开启）'

      return h(Button, {
        variant: 'ghost',
        'aria-label': label,
        'aria-pressed': enabled,
        title: label,
        disabled: busy || locked,
        style: { width: 32, height: 32, padding: 0, opacity: state === null ? 0.5 : enabled ? 1 : 0.45 },
        onClick: async () => {
          if (busy || state === null) return
          setBusy(true)
          try {
            setState(await writeState(!enabled))
          } catch {
            // 端点不可达时保持原状态，不假装切换成功。
          } finally {
            setBusy(false)
          }
        },
      }, h(IconSparkleRegular, { size: 16 }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'prompt-enhancer',
          order: 100,
        }, EnhanceToggle))
      },
    }
  },
})
