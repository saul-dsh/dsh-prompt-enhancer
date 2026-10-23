/**
 * dsh-prompt-enhancer 的 web 客户端部分。
 *
 * 交付形态遵循 dsh 的客户端插件协议：一个 ESM 文件，调用
 * `window.__ModuleLoader__.load({ id, factory(require) })`，返回 cordis 插件对象。
 * 这里只做一件事：在输入框工具栏左侧放一个 Sparkle 图标按钮（对齐 WorkBuddy 的
 * 「增强提示词」图标），点一下把当前草稿发给服务端改写，再用改写结果替换草稿。
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-enhancer',
  factory(require) {
    const React = require('react')
    const { Button, IconSparkleRegular, IconLoadingOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const ENDPOINT = '/api/prompt-enhancer/rewrite'
    const SPIN_STYLE_ID = 'dsh-prompt-enhancer-spin'

    /** 旋转动画的 keyframes（图标自带的 SVG 本身不带动画）。 */
    function ensureSpinStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(SPIN_STYLE_ID)) return
      const style = document.createElement('style')
      style.id = SPIN_STYLE_ID
      style.textContent = '@keyframes dsh-prompt-enhancer-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}'
      document.head.appendChild(style)
    }

    async function enhance(text) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error(`prompt-enhancer rewrite ${res.status}`)
      const data = await res.json()
      return typeof data?.text === 'string' ? data.text : ''
    }

    /** 输入框左侧的「增强提示词」按钮：把草稿改写后写回输入框。 */
    function EnhanceButton({ useInput, inputActions }) {
      const draft = useInput((state) => state.draft)
      const [busy, setBusy] = React.useState(false)
      const text = typeof draft === 'string' ? draft.trim() : ''
      const empty = text.length === 0
      const label = busy ? '正在增强提示词…' : '增强提示词'
      const icon = busy
        ? h('span', {
          style: { display: 'inline-flex', animation: 'dsh-prompt-enhancer-spin 1s linear infinite' },
        }, h(IconLoadingOutlineRegular, { size: 16 }))
        : h(IconSparkleRegular, { size: 16 })

      return h(Button, {
        variant: 'ghost',
        size: 'sm',
        'aria-label': label,
        title: label,
        disabled: busy || empty,
        style: { width: 28, height: 28, padding: 0, opacity: empty ? 0.45 : 1 },
        onClick: async () => {
          if (busy || empty) return
          setBusy(true)
          try {
            const enhanced = await enhance(text)
            if (enhanced.length > 0) inputActions.setDraft(enhanced)
          } catch (err) {
            // 端点不可达或改写失败时保留原草稿，不打断输入。
            console.error('[dsh-prompt-enhancer] enhance failed', err)
          } finally {
            setBusy(false)
          }
        },
      }, icon)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureSpinStyle()
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'prompt-enhancer',
          order: 100,
        }, EnhanceButton))
      },
    }
  },
})
