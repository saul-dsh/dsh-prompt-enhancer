/**
 * dsh-prompt-enhancer 的 web 客户端部分。
 *
 * 交付形态遵循 dsh 的客户端插件协议：一个 ESM 文件，调用
 * `window.__ModuleLoader__.load({ id, factory(require) })`，返回 cordis 插件对象。
 *
 * 做三件事：
 *   1. 输入框左侧 Sparkle 按钮：点一下手动增强当前草稿。
 *   2. 同一个按钮上悬浮静置：向上弹出强度滑块（Low / High / Max）+ 发送时自动增强开关。
 *   3. 发送拦截：自动增强开启时，点发送按钮或按 Enter 不会立刻发出，而是先把
 *      草稿送去增强、期间发送按钮显示三点旋转，拿到结果后写回草稿再 submit()。
 *
 * 拦截策略是捕获阶段监听（document capture），拿到事件后阻止它到达 React
 * 的事件根，避免 dsh 自己的 onClick 先触发。
 *
 * 定位方式：`[data-composer-dock]` 只是输入区底部那条 dock，编辑器和发送按钮
 * 都在它的**兄弟节点**里，所以容器要取 dock 的 parentElement，再按 aria-label
 * 语义（send / 发送 / 排队 / steer）找发送按钮。任何一步失败都直接放行原消息，
 * 绝不卡住发送。
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-enhancer',
  factory(require) {
    const React = require('react')
    const { Button, IconSparkleRegular, IconLoadingOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const ENDPOINT = '/api/prompt-enhancer'
    // 滑块只有三档；服务端仍认 off（配置层关闭用），但前端不再暴露。
    const LEVELS = ['low', 'high', 'max']
    const STORAGE_KEY = 'dsh-prompt-enhancer:settings'
    // 改默认值时抬版本号，旧数据直接丢弃，避免老用户卡在旧默认上。
    const STORAGE_VERSION = 3
    const STYLE_ID = 'dsh-prompt-enhancer-style'

    const LEVEL_META = {
      low: { label: 'Low', grad: 'linear-gradient(90deg,#16a34a,#22c55e)' },
      high: { label: 'High', grad: 'linear-gradient(90deg,#22c55e,#22d3ee)' },
      max: { label: 'Max', grad: 'linear-gradient(90deg,#22c55e,#06b6d4,#3b82f6)' },
    }

    // 填充区里从右往左流动的小点。delay 错开形成连续的光流，
    // size 不同是照抄 dsh 那个面板的观感：点大小不齐才不像机器画的。
    const SPARKS = [
      { delay: 0, size: 3, top: 30 },
      { delay: 0.22, size: 2, top: 62 },
      { delay: 0.45, size: 4, top: 42 },
      { delay: 0.68, size: 2, top: 70 },
      { delay: 0.9, size: 3, top: 26 },
      { delay: 1.13, size: 2, top: 58 },
      { delay: 1.35, size: 4, top: 36 },
      { delay: 1.58, size: 3, top: 66 },
    ]
    const SPARK_COUNT = { low: 3, high: 5, max: 8 }

    const PANEL_W = 240
    const PANEL_H = 178
    const HOVER_DELAY = 1500
    const CLOSE_DELAY = 260
    const EXIT_MS = 130

    /* ---------------------------------------------------------------- */
    /* 跨组件共享的设置（面板和拦截器都要读）                              */
    /* ---------------------------------------------------------------- */

    const settings = (() => {
      const fallback = { level: 'high', autoSend: false }
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        if (parsed?.v !== STORAGE_VERSION) return fallback
        return {
          // 旧版本存过 off，迁移成 high。
          level: LEVELS.includes(parsed?.level) ? parsed.level : fallback.level,
          autoSend: typeof parsed?.autoSend === 'boolean' ? parsed.autoSend : fallback.autoSend,
        }
      } catch {
        return fallback
      }
    })()

    const settingsListeners = new Set()

    function subscribeSettings(fn) {
      settingsListeners.add(fn)
      return () => { settingsListeners.delete(fn) }
    }

    function notifySettings() {
      for (const fn of settingsListeners) {
        try { fn({ ...settings }) } catch { /* ignore */ }
      }
    }

    function updateSettings(patch) {
      Object.assign(settings, patch)
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, v: STORAGE_VERSION })) } catch { /* ignore */ }
      notifySettings()
      // 同步给服务端：pre-step 兜底增强要用同一档位。
      if (patch.level !== undefined) {
        fetch(`${ENDPOINT}/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ level: settings.level }),
        }).catch(() => { /* 端点不可达时不影响前端增强 */ })
      }
    }

    /* ---------------------------------------------------------------- */
    /* 样式                                                              */
    /* ---------------------------------------------------------------- */

    function ensureStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
@keyframes dsh-pe-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes dsh-pe-dots{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}

/* 发送按钮上的三点旋转：盖住原图标，用三个圆点绕中心转 */
button[data-dsh-pe-busy]{position:relative!important}
button[data-dsh-pe-busy]>*{opacity:0!important}
button[data-dsh-pe-busy]::after{
  content:'';position:absolute;inset:0;margin:auto;width:14px;height:14px;
  background:
    radial-gradient(circle 1.7px at 7px 2px,currentColor 100%,transparent 0),
    radial-gradient(circle 1.7px at 11.3px 9.5px,currentColor 100%,transparent 0),
    radial-gradient(circle 1.7px at 2.7px 9.5px,currentColor 100%,transparent 0);
  animation:dsh-pe-dots .85s linear infinite;
  transform-origin:center;
}

.dsh-pe-panel{
  position:fixed;z-index:9999;width:240px;padding:14px 16px 12px;
  border-radius:10px;border:1px solid rgba(255,255,255,.10);
  background:#262626;color:#e8e8e8;
  box-shadow:0 12px 32px rgba(0,0,0,.42),0 2px 6px rgba(0,0,0,.28);
  font-size:11px;line-height:1.45;
  user-select:none;
  /* 从按钮一侧「长出来」：底部中心为原点缩放，配合快出慢收的缓动 */
  transform-origin:50% 100%;
  animation:dsh-pe-pop .18s cubic-bezier(.16,1,.3,1) both;
  will-change:transform,opacity;
}
.dsh-pe-panel[data-closing="true"]{
  animation:dsh-pe-unpop .13s cubic-bezier(.4,0,.7,.2) both;
}
@keyframes dsh-pe-pop{
  from{opacity:0;transform:scale(.82) translateY(10px)}
  60%{opacity:1}
  to{opacity:1;transform:scale(1) translateY(0)}
}
@keyframes dsh-pe-unpop{
  from{opacity:1;transform:scale(1) translateY(0)}
  to{opacity:0;transform:scale(.92) translateY(5px)}
}
.dsh-pe-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px}
.dsh-pe-title{font-size:11px;color:rgba(255,255,255,.55);letter-spacing:.02em}
.dsh-pe-value{font-size:15px;font-weight:500;color:#fff;letter-spacing:.01em}
.dsh-pe-track{position:relative;height:32px;display:flex;align-items:center;cursor:pointer;touch-action:none}
.dsh-pe-rail{
  position:absolute;left:12px;right:12px;height:12px;border-radius:6px;
  background:rgba(255,255,255,.10);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.05);
}
.dsh-pe-fill{
  position:absolute;left:12px;top:50%;height:12px;border-radius:6px;
  transform:translateY(-50%);overflow:hidden;
  transition:width .18s cubic-bezier(.4,0,.2,1),background .2s ease;
}
.dsh-pe-spark{
  position:absolute;border-radius:50%;background:rgba(255,255,255,.88);
  animation:dsh-pe-flow 1.8s linear infinite;
}
/* 小点从右往左流动，像能量被吸进手柄，不是原地闪。 */
@keyframes dsh-pe-flow{
  from{left:100%;opacity:0}
  10%{opacity:.85}
  85%{opacity:.85}
  to{left:-6px;opacity:0}
}
.dsh-pe-tick{
  position:absolute;top:50%;width:3px;height:3px;border-radius:50%;
  background:rgba(255,255,255,.28);transform:translate(-50%,-50%);pointer-events:none;
}
.dsh-pe-knob{
  position:absolute;top:50%;width:22px;height:22px;border-radius:50%;
  background:#fff;
  box-shadow:0 1px 3px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.05);
  transform:translate(-50%,-50%) scale(1);
  transition:left .18s cubic-bezier(.4,0,.2,1),transform .12s ease;
  pointer-events:none;
}
.dsh-pe-knob[data-dragging="true"]{
  transition:left 0s,transform .12s ease;
  transform:translate(-50%,-50%) scale(1.12);
}
.dsh-pe-legend{display:flex;justify-content:space-between;margin-top:10px;padding:0 10px}
.dsh-pe-legend span{font-size:11px;color:rgba(255,255,255,.36);cursor:pointer;transition:color .15s}
.dsh-pe-legend span[data-active="true"]{color:#fff;font-weight:500}
.dsh-pe-legend span:hover{color:rgba(255,255,255,.75)}
.dsh-pe-sep{height:1px;margin:13px 0 11px;background:rgba(255,255,255,.08)}
.dsh-pe-row{display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:1px 0}
.dsh-pe-row-label{font-size:11px;color:rgba(255,255,255,.80)}
.dsh-pe-switch{
  position:relative;width:28px;height:16px;border-radius:8px;
  background:rgba(255,255,255,.14);transition:background .18s;
}
.dsh-pe-switch[data-on="true"]{background:#22c55e}
.dsh-pe-switch::after{
  content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;
  background:#fff;transition:transform .18s cubic-bezier(.4,0,.2,1);
}
.dsh-pe-switch[data-on="true"]::after{transform:translateX(12px)}
.dsh-pe-desc{margin-top:9px;font-size:10px;color:rgba(255,255,255,.36);line-height:1.45;min-height:15px}
`
      document.head.appendChild(style)
    }

    /* ---------------------------------------------------------------- */
    /* 网络                                                              */
    /* ---------------------------------------------------------------- */

    async function enhance(text, level) {
      const res = await fetch(`${ENDPOINT}/rewrite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, level }),
      })
      if (!res.ok) throw new Error(`prompt-enhancer rewrite ${res.status}`)
      const data = await res.json()
      return typeof data?.text === 'string' ? data.text : ''
    }

    /** 把拦截决策写进宿主的排查日志，出问题时直接看 ~/.dsh/prompt-enhancer-debug.log。 */
    function report(payload) {
      try {
        fetch(`${ENDPOINT}/debug`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => { /* ignore */ })
      } catch { /* ignore */ }
    }

    /* ---------------------------------------------------------------- */
    /* 发送拦截                                                          */
    /* ---------------------------------------------------------------- */

    /** 当前会话的输入动作与草稿，由挂载的组件持续写入。 */
    const live = { actions: null, draft: '' }

    /**
     * 输入区根节点。
     * `[data-composer-dock]` 只是底部那条 dock（ContextMeter 之类），
     * 编辑器和发送按钮都在它的**兄弟节点** css.composer 里，
     * 所以容器要取 dock 的父元素，否则一个按钮都找不到。
     */
    function composerRoot() {
      const dock = document.querySelector('[data-composer-dock]')
      return dock && dock.parentElement ? dock.parentElement : null
    }

    /** 发送按钮 = 输入区里最后一个 aria-label 语义为「发送」的可见按钮。 */
    function findSendButton() {
      // 优先在输入区里找；输入区认不出来就全局找，不把成败绑在某个容器的层级上。
      const scopes = []
      const root = composerRoot()
      if (root) scopes.push(root)
      scopes.push(document)

      for (const scope of scopes) {
        const buttons = scope.querySelectorAll('button[aria-label]')
        for (let i = buttons.length - 1; i >= 0; i--) {
          const btn = buttons[i]
          if (btn.disabled) continue
          if (btn.offsetParent === null) continue
          const label = (btn.getAttribute('aria-label') || '').toLowerCase()
          if (label.includes('send') || label.includes('发送') || label.includes('排队') || label.includes('steer')) {
            return btn
          }
        }
      }
      return null
    }

    function inComposer(node) {
      if (!node || !node.closest) return false
      // 编辑器本身是 contenteditable，直接认它，不用往上找容器。
      if (node.closest('[contenteditable="true"]')) return true
      const root = composerRoot()
      return !!(root && root.contains(node))
    }

    let intercepting = false

    function shouldIntercept() {
      return settings.autoSend && settings.level !== 'off' && !intercepting && live.actions !== null
    }

    /** 增强结果写回草稿后停留多久再自动发送。太短用户看不见变化，像直接发原文。 */
    const REVEAL_MS = 700

    async function enhanceThenSend(button) {
      if (intercepting) return
      const raw = live.draft.trim()
      const actions = live.actions
      if (!actions) return

      // 空草稿（纯附件发送）或斜杠命令：不增强，直接放行原始发送。
      if (raw.length === 0 || raw.startsWith('/')) {
        actions.submit()
        return
      }

      intercepting = true
      if (button) button.setAttribute('data-dsh-pe-busy', '1')
      try {
        const enhanced = await enhance(raw, settings.level)
        if (enhanced.length > 0 && enhanced !== raw) {
          actions.setDraft(enhanced)
          // 先把增强结果摆进输入框让用户看见，停一下再发出去。
          await new Promise((r) => setTimeout(r, REVEAL_MS))
        }
      } catch (err) {
        // 增强失败就按原文发，不能让用户卡在输入框里。
        console.error('[dsh-prompt-enhancer] enhance failed, sending original', err)
      }
      if (button) button.removeAttribute('data-dsh-pe-busy')
      // 提交前一直占着锁，避免 700ms 里重复点击触发第二次增强。
      intercepting = false
      actions.submit()
    }

    function onClickCapture(e) {
      if (!(e.target instanceof Node)) return
      const hit = e.target.closest ? e.target.closest('button') : null
      const hitLabel = hit ? (hit.getAttribute('aria-label') || '') : ''
      const looksLikeSend = /send|发送|排队|steer/i.test(hitLabel)

      if (!shouldIntercept()) {
        // 只记录「像发送按钮」的点击，避免刷屏。
        if (looksLikeSend) {
          report({
            phase: 'skip',
            label: hitLabel,
            autoSend: settings.autoSend,
            level: settings.level,
            hasActions: live.actions !== null,
            intercepting,
          })
        }
        return
      }

      const btn = findSendButton()
      if (!btn || !btn.contains(e.target)) {
        if (looksLikeSend) {
          report({ phase: 'no-target', label: hitLabel, found: btn ? btn.getAttribute('aria-label') : null })
        }
        return
      }

      // 正常拦截不记日志，只有出问题的分支才写，避免日志无限增长。
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      void enhanceThenSend(btn)
    }

    function onKeyDownCapture(e) {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
      // 中文输入法组合中的回车是在选词，不是发送。
      if (e.isComposing || e.keyCode === 229) return
      if (!inComposer(e.target)) return
      if (!shouldIntercept()) return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      void enhanceThenSend(findSendButton())
    }

    let listening = false
    function installInterceptors() {
      if (listening || typeof document === 'undefined') return
      listening = true
      document.addEventListener('click', onClickCapture, true)
      document.addEventListener('keydown', onKeyDownCapture, true)
      syncFromServer()
    }

    /** 本机没存过设置时，沿用服务端配置的档位，避免刷新后跳回默认值。 */
    function syncFromServer() {
      try {
        if (localStorage.getItem(STORAGE_KEY)) return
      } catch { /* ignore */ }
      fetch(`${ENDPOINT}/settings`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data || !LEVELS.includes(data.level)) return
          settings.level = data.level
          notifySettings()
        })
        .catch(() => { /* 端点不可达就用本地默认 */ })
    }

    /* ---------------------------------------------------------------- */
    /* 组件：强度面板（纯展示）                                            */
    /* ---------------------------------------------------------------- */

    const LEVEL_DESC = {
      low: '只修歧义和冗余，不动结构',
      high: '补全目标与约束，保留原意',
      max: '第一性原理重构，假设逐条标注',
    }

    function LevelPanel({ level, autoSend, dragging, trackRef, onPick, onDragEnd, onChangeLevel, onToggleAuto }) {
      const index = Math.max(0, LEVELS.indexOf(level))
      const pct = (index / (LEVELS.length - 1)) * 100
      const meta = LEVEL_META[level] ?? LEVEL_META.high
      // 轨道左右各留 12px 给手柄半径，手柄不会压在轨道圆角外。
      const knobLeft = `calc(${pct}% + ${(12 - pct * 0.24).toFixed(2)}px)`
      const fillWidth = `calc(${pct}% - ${(pct * 0.24).toFixed(2)}px)`
      const tickLeft = (i) => {
        const p = (i / (LEVELS.length - 1)) * 100
        return `calc(${p}% + ${(12 - p * 0.24).toFixed(2)}px)`
      }

      return h('div', null,
        h('div', { className: 'dsh-pe-head' },
          h('span', { className: 'dsh-pe-title' }, '增强强度'),
          h('span', { className: 'dsh-pe-value' }, meta.label),
        ),
        h('div', {
          className: 'dsh-pe-track',
          ref: trackRef,
          onPointerDown: (ev) => {
            ev.preventDefault()
            try { ev.currentTarget.setPointerCapture(ev.pointerId) } catch { /* ignore */ }
            onPick(ev.clientX, true)
          },
          onPointerMove: (ev) => { if (dragging) onPick(ev.clientX, false) },
          onPointerUp: (ev) => {
            try { ev.currentTarget.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
            onDragEnd()
          },
          onPointerCancel: onDragEnd,
        },
        h('div', { className: 'dsh-pe-rail' }),
        h('div', { className: 'dsh-pe-fill', style: { width: fillWidth, background: meta.grad } },
          ...SPARKS.slice(0, SPARK_COUNT[level] ?? 5).map((s, i) => h('i', {
            key: `spark-${i}`,
            className: 'dsh-pe-spark',
            style: {
              top: `${s.top}%`,
              width: `${s.size}px`,
              height: `${s.size}px`,
              marginTop: `${-s.size / 2}px`,
              animationDelay: `${s.delay}s`,
            },
          })),
        ),
        ...LEVELS.map((lv, i) => h('div', {
          key: `tick-${lv}`,
          className: 'dsh-pe-tick',
          style: { left: tickLeft(i) },
        })),
        h('div', {
          className: 'dsh-pe-knob',
          'data-dragging': String(dragging),
          style: { left: knobLeft },
        }),
        ),
        h('div', { className: 'dsh-pe-legend' },
          ...LEVELS.map((lv) => h('span', {
            key: lv,
            'data-active': String(level === lv),
            onClick: () => onChangeLevel(lv),
          }, LEVEL_META[lv].label)),
        ),
        h('div', { className: 'dsh-pe-sep' }),
        h('div', { className: 'dsh-pe-row', onClick: onToggleAuto },
          h('span', { className: 'dsh-pe-row-label' }, '发送时自动增强'),
          h('span', { className: 'dsh-pe-switch', 'data-on': String(autoSend) }),
        ),
        h('div', { className: 'dsh-pe-desc' }, autoSend
          ? LEVEL_DESC[level]
          : '仅手动增强，发送不拦截'),
      )
    }

    /* ---------------------------------------------------------------- */
    /* 组件：增强按钮 + 悬浮强度面板                                       */
    /* ---------------------------------------------------------------- */

    function EnhanceButton({ useInput, inputActions }) {
      const draft = useInput((s) => s.draft)
      const [busy, setBusy] = React.useState(false)
      /** 增强后保留原文，草稿没被改动前可以一键撤销。 */
      const [undo, setUndo] = React.useState(null)
      const [state, setState] = React.useState({ ...settings })
      const [open, setOpen] = React.useState(false)
      const [closing, setClosing] = React.useState(false)
      const [pos, setPos] = React.useState(null)
      const [dragging, setDragging] = React.useState(false)
      const anchorRef = React.useRef(null)
      const trackRef = React.useRef(null)
      const hoverTimer = React.useRef(null)
      const closeTimer = React.useRef(null)
      const exitTimer = React.useRef(null)

      const text = typeof draft === 'string' ? draft.trim() : ''
      const empty = text.length === 0

      // 把最新的草稿和动作暴露给发送拦截器。
      live.draft = typeof draft === 'string' ? draft : ''
      live.actions = inputActions ?? null

      React.useEffect(() => subscribeSettings(setState), [])
      React.useEffect(() => () => {
        clearTimeout(hoverTimer.current)
        clearTimeout(closeTimer.current)
        clearTimeout(exitTimer.current)
      }, [])

      // 撤销只在草稿被改动后失效。增强结果还留在输入框里就一直挂着，
      // 不设超时：用户可能看半天才决定要不要退回去。
      React.useEffect(() => {
        if (undo === null) return
        if (typeof draft !== 'string' || draft !== undo.enhanced) setUndo(null)
      }, [draft, undo])

      // 开始增强时，已经打开的面板立刻收起，别挡着看结果。
      React.useEffect(() => {
        if (busy) hide()
      }, [busy])

      const place = () => {
        const el = anchorRef.current
        if (!el) return null
        const r = el.getBoundingClientRect()
        let left = r.left + r.width / 2 - PANEL_W / 2
        left = Math.max(8, Math.min(left, (window.innerWidth || 1024) - PANEL_W - 8))
        // 输入框贴着屏幕底部，面板默认向上；上方真的放不下才落到下方。
        const above = r.top - PANEL_H - 10
        return { top: above > 8 ? above : r.bottom + 10, left }
      }

      const show = () => {
        // 增强进行中不弹面板：这时候鼠标只是停在按钮上等结果，不是在挑档位。
        if (busy) return
        clearTimeout(closeTimer.current)
        clearTimeout(exitTimer.current)
        setClosing(false)
        const p = place()
        if (!p) return
        setPos(p)
        setOpen(true)
      }

      /** 先播退场动画再卸载，避免面板「啪」地消失。 */
      const hide = () => {
        if (!open) return
        clearTimeout(exitTimer.current)
        setClosing(true)
        exitTimer.current = setTimeout(() => {
          setOpen(false)
          setClosing(false)
        }, EXIT_MS)
      }

      const onEnter = () => {
        clearTimeout(closeTimer.current)
        clearTimeout(exitTimer.current)
        if (busy) return
        if (open) {
          // 正在退场时鼠标又回来了：撤销关闭。
          setClosing(false)
          return
        }
        clearTimeout(hoverTimer.current)
        hoverTimer.current = setTimeout(show, HOVER_DELAY)
      }

      const onLeave = () => {
        clearTimeout(hoverTimer.current)
        if (dragging) return
        clearTimeout(closeTimer.current)
        closeTimer.current = setTimeout(hide, CLOSE_DELAY)
      }

      React.useEffect(() => {
        if (!open) return
        const onEsc = (ev) => { if (ev.key === 'Escape') hide() }
        const onResize = () => hide()
        document.addEventListener('keydown', onEsc, true)
        window.addEventListener('resize', onResize)
        return () => {
          document.removeEventListener('keydown', onEsc, true)
          window.removeEventListener('resize', onResize)
        }
      }, [open, dragging])

      const pick = (clientX, start) => {
        if (start) setDragging(true)
        const track = trackRef.current
        if (!track) return
        const r = track.getBoundingClientRect()
        if (r.width <= 0) return
        const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
        const next = LEVELS[Math.round(ratio * (LEVELS.length - 1))]
        if (next !== state.level) updateSettings({ level: next })
      }

      const levelLabel = (LEVEL_META[state.level] ?? LEVEL_META.high).label
      const showUndo = undo !== null && !busy && text === undo.enhanced
      const label = busy
        ? '正在增强提示词…'
        : showUndo
          ? '撤销增强，恢复原文'
          : `增强提示词（强度 ${levelLabel}）`
      const icon = busy
        ? h('span', {
          style: { display: 'inline-flex', animation: 'dsh-pe-spin 1s linear infinite' },
        }, h(IconLoadingOutlineRegular, { size: 16 }))
        : showUndo
          ? h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
            h('path', {
              d: 'M5.5 4.5L2 8l3.5 3.5',
              fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6,
              'stroke-linecap': 'round', 'stroke-linejoin': 'round',
            }),
            h('path', {
              d: 'M2 8h7.5a3.5 3.5 0 010 7H7.5',
              fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6,
              'stroke-linecap': 'round',
            }))
          : h(IconSparkleRegular, { size: 16 })

      return h('span', {
        ref: anchorRef,
        style: { display: 'inline-flex' },
        onMouseEnter: onEnter,
        onMouseLeave: onLeave,
      },
      h(Button, {
        variant: 'ghost',
        size: 'sm',
        'aria-label': label,
        title: label,
        disabled: busy || empty,
        style: {
          width: 28, height: 28, padding: 0,
          opacity: empty ? 0.45 : 1,
          color: showUndo ? '#ef4444' : undefined,
        },
        onClick: async () => {
          if (busy) return
          if (showUndo) {
            inputActions.setDraft(undo.original)
            setUndo(null)
            return
          }
          if (empty) return
          setBusy(true)
          try {
            const enhanced = await enhance(text, settings.level)
            if (enhanced.length > 0 && enhanced !== text) {
              setUndo({ original: text, enhanced })
              inputActions.setDraft(enhanced)
            }
          } catch (err) {
            console.error('[dsh-prompt-enhancer] enhance failed', err)
          } finally {
            setBusy(false)
          }
        },
      }, icon),

      open && pos ? h('div', {
        className: 'dsh-pe-panel',
        'data-closing': String(closing),
        style: { top: pos.top, left: pos.left },
        onMouseEnter: () => { clearTimeout(closeTimer.current) },
        onMouseLeave: onLeave,
        onMouseDown: (ev) => ev.stopPropagation(),
      }, h(LevelPanel, {
        level: state.level,
        autoSend: state.autoSend,
        dragging,
        trackRef,
        onPick: pick,
        onDragEnd: () => setDragging(false),
        onChangeLevel: (lv) => updateSettings({ level: lv }),
        onToggleAuto: () => updateSettings({ autoSend: !state.autoSend }),
      })) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle()
        installInterceptors()
        // 排查用：控制台执行 __dshPeDebug.findSendButton() 能直接看到能不能定位到发送按钮。
        if (typeof window !== 'undefined') {
          window.__dshPeDebug = {
            version: '0.2.2',
            settings,
            live,
            composerRoot,
            findSendButton,
            intercepting: () => intercepting,
          }
          // 启动 2.5 秒后记一次现场，DOM 那时才渲染完。
          setTimeout(() => {
            const btn = findSendButton()
            report({
              phase: 'load',
              version: '0.2.2',
              autoSend: settings.autoSend,
              level: settings.level,
              hasDock: !!document.querySelector('[data-composer-dock]'),
              hasRoot: !!composerRoot(),
              sendBtn: btn ? btn.getAttribute('aria-label') : null,
              buttons: [...document.querySelectorAll('button[aria-label]')]
                .filter((b) => b.offsetParent !== null)
                .slice(0, 12)
                .map((b) => b.getAttribute('aria-label')),
            })
          }, 2500)
        }
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'prompt-enhancer',
          order: 100,
        }, EnhanceButton))
      },
    }
  },
})
