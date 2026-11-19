// 浮层的原生实现：提示、菜单、对话框、轻提示。
// 正式应用里这些全部由 Base UI 提供；这里只是模拟它输出的结构和状态属性
// （data-open / data-starting-style / data-ending-style / data-highlighted / data-checked …），
// 这样同一份 CSS 在原型和正式应用里表现完全一致。
import { $, $$, esc, icon, t } from './core.js'

/** 出现：先带着 data-starting-style 挂上去，下一帧去掉，触发 CSS 过渡 */
export function present(el) {
  el.setAttribute('data-open', '')
  el.removeAttribute('data-closed')
  el.removeAttribute('data-ending-style')
  el.setAttribute('data-starting-style', '')
  void el.offsetWidth
  requestAnimationFrame(() => el.removeAttribute('data-starting-style'))
}

/** 消失：加上 data-ending-style，等过渡结束后再移除 */
export function dismiss(el, after) {
  if (!el || el.hasAttribute('data-ending-style')) return
  el.removeAttribute('data-open')
  el.setAttribute('data-closed', '')
  el.setAttribute('data-ending-style', '')
  let done = false
  const finish = () => {
    if (done) return
    done = true
    after ? after() : el.remove()
  }
  el.addEventListener('transitionend', (e) => e.target === el && finish(), { once: false })
  setTimeout(finish, 420)
}

/** 把浮层摆到锚点旁边，并写入 Base UI 同名的 CSS 变量 */
function place(positioner, anchor, { side = 'bottom', align = 'center', offset = 8 } = {}) {
  const a = anchor.getBoundingClientRect()
  positioner.style.cssText = 'position:fixed;left:0;top:0;'
  const popup = positioner.firstElementChild
  popup.style.setProperty('--anchor-width', `${a.width}px`)
  const p = positioner.getBoundingClientRect()
  const vw = innerWidth
  const vh = innerHeight
  if (side === 'bottom' && a.bottom + offset + p.height > vh - 8) side = 'top'
  else if (side === 'top' && a.top - offset - p.height < 8) side = 'bottom'
  let x = align === 'start' ? a.left : align === 'end' ? a.right - p.width : a.left + a.width / 2 - p.width / 2
  x = Math.max(8, Math.min(x, vw - p.width - 8))
  const y = side === 'bottom' ? a.bottom + offset : a.top - offset - p.height
  positioner.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  positioner.dataset.side = side
  popup.dataset.side = side
  const ox = Math.round(a.left + a.width / 2 - x)
  popup.style.setProperty('--transform-origin', `${ox}px ${side === 'bottom' ? '0px' : '100%'}`)
  popup.style.setProperty('--available-height', `${side === 'bottom' ? vh - a.bottom - offset - 8 : a.top - offset - 8}px`)
}

// ───────────────────────── 提示 ─────────────────────────
let tipEl = null
let tipTimer = 0
let tipAnchor = null
let lastTipClosed = 0

function hideTip() {
  clearTimeout(tipTimer)
  if (tipEl) {
    const host = tipEl.parentElement
    dismiss(tipEl, () => host.remove())
    tipEl = null
    lastTipClosed = performance.now()
  }
  tipAnchor = null
}

export function initTooltips() {
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-tip]')
    if (el === tipAnchor) return
    hideTip()
    if (!el || e.pointerType === 'touch') return
    tipAnchor = el
    // 刚关掉一个提示又移到相邻按钮上：立即出现（Base UI 的 data-instant）
    const instant = performance.now() - lastTipClosed < 300
    tipTimer = setTimeout(
      () => {
        if (!el.isConnected || el.hasAttribute('data-popup-open')) return
        const host = document.createElement('div')
        host.className = 'layer-tooltip'
        const kbd = el.dataset.kbd ? `<kbd class="kbd">${esc(el.dataset.kbd)}</kbd>` : ''
        host.innerHTML = `<div class="tooltip" role="tooltip">${esc(el.dataset.tip)}${kbd}</div>`
        document.body.append(host)
        tipEl = host.firstElementChild
        place(host, el, { side: el.dataset.tipSide || 'bottom' })
        if (instant) tipEl.setAttribute('data-instant', '')
        present(tipEl)
      },
      instant ? 0 : 500,
    )
  })
  for (const ev of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(ev, hideTip, { capture: true, passive: true })
}

// ───────────────────────── 菜单（同时充当下拉选择） ─────────────────────────
let closeMenu = null

/**
 * @param anchor 触发按钮
 * @param opts.label 分组小标题（可选）
 * @param opts.items [{ value, label }]
 * @param opts.value 当前选中的值
 * @param opts.onSelect 选中回调
 */
export function openMenu(anchor, { label, items, value, onSelect, side = 'bottom', align = 'center' }) {
  if (closeMenu) {
    const same = anchor.hasAttribute('data-popup-open')
    closeMenu()
    if (same) return
  }
  hideTip()
  const host = document.createElement('div')
  host.className = 'layer-popover'
  host.innerHTML = `<div class="menu" role="menu" tabindex="-1">
    ${label ? `<div class="menu__label">${esc(label)}</div>` : ''}
    ${items
      .map(
        (it) => `<div class="menu__item" role="menuitemradio" aria-checked="${it.value === value}" data-value="${esc(it.value)}"${it.value === value ? ' data-checked' : ''}>
          <span>${esc(it.label)}</span>${it.value === value ? `<span class="menu__check">${icon('check', 'sm')}</span>` : ''}
        </div>`,
      )
      .join('')}
  </div>`
  document.body.append(host)
  const menu = host.firstElementChild
  const rows = $$('.menu__item', menu)
  place(host, anchor, { side, align })
  anchor.setAttribute('data-popup-open', '')
  present(menu)
  menu.focus({ preventScroll: true })

  const highlight = (row) => rows.forEach((r) => r.toggleAttribute('data-highlighted', r === row))
  const current = () => rows.findIndex((r) => r.hasAttribute('data-highlighted'))
  const close = () => {
    closeMenu = null
    anchor.removeAttribute('data-popup-open')
    document.removeEventListener('pointerdown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
    // 关闭后焦点回到触发按钮（Base UI 的 Menu 自带这个行为）
    if (menu.contains(document.activeElement)) anchor.focus({ preventScroll: true })
    dismiss(menu, () => host.remove())
  }
  const choose = (row) => {
    const picked = items.find((it) => String(it.value) === row.dataset.value)
    close()
    onSelect?.(picked.value)
  }
  const onDown = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close()
  }
  const onKey = (e) => {
    const i = current()
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowDown') highlight(rows[(i + 1) % rows.length])
    else if (e.key === 'ArrowUp') highlight(rows[(i - 1 + rows.length) % rows.length])
    else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) choose(rows[i])
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  menu.addEventListener('pointermove', (e) => {
    const row = e.target.closest('.menu__item')
    if (row) highlight(row)
  })
  menu.addEventListener('pointerleave', () => highlight(null))
  menu.addEventListener('click', (e) => {
    const row = e.target.closest('.menu__item')
    if (row) choose(row)
  })
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('keydown', onKey, true)
  closeMenu = close
  return close
}

// ───────────────────────── 对话框 ─────────────────────────
/** 确认对话框：返回 Promise<boolean> */
export function confirmDialog({ title, desc = '', confirm, danger = false }) {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    host.innerHTML = `<div class="dialog-backdrop"></div>
      <div class="dialog-viewport">
        <div class="dialog" role="alertdialog" aria-modal="true" tabindex="-1">
          <h2 class="dialog__title">${esc(title)}</h2>
          ${desc ? `<p class="dialog__desc">${esc(desc)}</p>` : ''}
          <div class="dialog__actions">
            <button class="btn btn--ghost" data-act="cancel">${esc(t().action.cancel)}</button>
            <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-act="ok">${esc(confirm)}</button>
          </div>
        </div>
      </div>`
    document.body.append(host)
    const backdrop = $('.dialog-backdrop', host)
    const dialog = $('.dialog', host)
    const prev = document.activeElement
    present(backdrop)
    present(dialog)
    $('[data-act="cancel"]', host).focus({ preventScroll: true })
    const close = (ok) => {
      document.removeEventListener('keydown', onKey, true)
      dismiss(backdrop, () => {})
      dismiss(dialog, () => host.remove())
      prev?.focus?.({ preventScroll: true })
      resolve(ok)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close(false)
      } else if (e.key === 'Tab') {
        // 焦点留在对话框里
        const f = $$('button', dialog)
        const i = f.indexOf(document.activeElement)
        e.preventDefault()
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    host.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act
      if (act) close(act === 'ok')
    })
  })
}

// ───────────────────────── 轻提示 ─────────────────────────
let toastTimer = 0

export function toast(text, { action } = {}) {
  let viewport = $('.toast-viewport')
  if (!viewport) {
    viewport = document.createElement('div')
    viewport.className = 'toast-viewport'
    viewport.setAttribute('role', 'status')
    document.body.append(viewport)
  }
  // 一次只显示一条：旧的立刻让位
  $$('.toast', viewport).forEach((old) => dismiss(old))
  const el = document.createElement('div')
  el.className = 'toast'
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button class="toast__action">${esc(action.label)}</button>` : ''}`
  viewport.append(el)
  present(el)
  if (action)
    $('.toast__action', el).addEventListener('click', () => {
      action.onClick()
      dismiss(el)
    })
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => dismiss(el), action ? 4000 : 2400)
}
