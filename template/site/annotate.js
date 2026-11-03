// Injected into a design file when the board opens it in comment mode (?annotate=1). Runs inside the sandboxed
// iframe; talks to the board only through postMessage. Hover outlines an element, click picks it, a text
// selection quotes it; the board sends back pins for existing notes.
(() => {
  const css = `
    .__an-hover{position:absolute;pointer-events:none;outline:2px solid #e2231a;outline-offset:1px;z-index:2147483646;background:rgba(226,35,26,.06)}
    .__an-pin{position:absolute;z-index:2147483647;min-width:18px;height:18px;padding:0 4px;background:#e2231a;color:#fff;font:600 11px/18px system-ui,sans-serif;text-align:center;pointer-events:none;transform:translate(-50%,-50%)}
    .__an-box{position:absolute;pointer-events:none;z-index:2147483645;outline:2px dashed #e2231a;outline-offset:1px}
    .__an-on *{cursor:crosshair!important}`
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style)
  const hover = document.createElement('div'); hover.className = '__an-hover'; hover.style.display = 'none'
  document.documentElement.appendChild(hover)
  let on = true, pins = []
  document.documentElement.classList.add('__an-on')

  const ours = (el) => el && el.className && String(el.className).startsWith('__an-')
  function selectorOf(el) {
    const parts = []
    for (let e = el; e && e.nodeType === 1 && e !== document.body && parts.length < 6; e = e.parentElement) {
      if (e.id) { parts.unshift(`#${CSS.escape(e.id)}`); break }
      let s = e.tagName.toLowerCase()
      const cls = [...e.classList].filter((c) => !c.startsWith('__an-')).slice(0, 2)
      if (cls.length) s += '.' + cls.map((c) => CSS.escape(c)).join('.')
      const sib = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName) : []
      if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(e) + 1})`
      parts.unshift(s)
    }
    return parts.join(' > ')
  }
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)] }
  function place(box, el) { const [x, y, w, h] = rectOf(el); Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px', display: 'block' }) }
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.alt || '').replace(/\s+/g, ' ').trim().slice(0, 160)

  addEventListener('mousemove', (e) => {
    if (!on) return
    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (!el || ours(el) || el === document.documentElement || el === document.body) { hover.style.display = 'none'; return }
    place(hover, el)
  }, true)
  addEventListener('click', (e) => {
    if (!on) return
    e.preventDefault(); e.stopPropagation()
    const el = e.target
    if (!el || ours(el)) return
    const quote = String(getSelection() || '').trim().slice(0, 400)
    parent.postMessage({ type: 'annotate:pick', selector: selectorOf(el), tag: el.tagName.toLowerCase(), text: label(el), quote,
      rect: rectOf(el), viewport: [innerWidth, innerHeight] }, '*')
  }, true)
  // A text selection without a click on an element: quote it, anchored on its parent element.
  addEventListener('mouseup', () => {
    if (!on) return
    const s = getSelection(); const q = String(s || '').trim()
    if (!q || !s.anchorNode) return
    const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement
    parent.postMessage({ type: 'annotate:pick', selector: selectorOf(el), tag: el.tagName.toLowerCase(), text: label(el), quote: q.slice(0, 400),
      rect: rectOf(el), viewport: [innerWidth, innerHeight] }, '*')
  }, true)
  // Keep forms and links inert in comment mode.
  addEventListener('submit', (e) => { if (on) e.preventDefault() }, true)

  function drawPins() {
    document.querySelectorAll('.__an-pin,.__an-box').forEach((n) => n.remove())
    for (const p of pins) {
      let el = null
      try { el = document.querySelector(p.selector) } catch {}
      const [x, y, w, h] = el ? rectOf(el) : p.rect || [0, 0, 0, 0]
      const box = document.createElement('div'); box.className = '__an-box'
      Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px', opacity: p.active ? 1 : .55 })
      const pin = document.createElement('div'); pin.className = '__an-pin'; pin.textContent = p.n
      Object.assign(pin.style, { left: x + 'px', top: y + 'px' })
      document.documentElement.append(box, pin)
      if (p.active && el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }
  addEventListener('message', (e) => {
    const d = e.data || {}
    if (d.type === 'annotate:pins') { pins = d.pins || []; drawPins() }
    if (d.type === 'annotate:mode') { on = !!d.on; document.documentElement.classList.toggle('__an-on', on); if (!on) hover.style.display = 'none' }
  })
  addEventListener('resize', drawPins)
  parent.postMessage({ type: 'annotate:ready' }, '*')
})()
