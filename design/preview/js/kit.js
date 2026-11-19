// 规格页（#/kit）：把令牌和每个组件的每种状态摆在一页上，方便对照。
// 这一页是「说明书」，不是应用界面：上面的标注文字只在这里出现，正式应用里没有这个页面。
import { $, $$, esc, icon, tip, t, data, item, store, continuing } from './core.js'
import { metaRow, posterCard, wideCard, continueCard, skeletonCard, tabs, syncTabs, setTab, favoriteButton, empty } from './parts.js'
import { openMenu, confirmDialog, toast } from './ui.js'
import { episodeCells } from './views.js'

const sec = (id, title, body) => `<section class="kit__sec" id="kit-${id}"><h2 class="kit__h">${title}</h2>${body}</section>`
const row = (label, body, cls = '') => `<div class="kit__row"><div class="kit__label">${label}</div><div class="kit__cell ${cls}">${body}</div></div>`
const swatch = (name, note = '') => `<div class="kit__swatch"><i style="background:var(${name})"></i><code>${name}</code><span data-value="${name}"></span>${note ? `<em>${note}</em>` : ''}</div>`
const swatches = (list) => `<div class="kit__swatches">${list.map((s) => (Array.isArray(s) ? swatch(...s) : swatch(s))).join('')}</div>`
const tokenRows = (list) => `<div class="kit__tokens">${list.map(([name, note]) => `<code>${name}</code><span data-value="${name}"></span><em>${note}</em>`).join('')}</div>`

export function kit(el) {
  const c = t()
  const sample = item('wugang-laixin')
  const wide = data.catalog.items.find((it) => it.type === 'variety')
  const titled = data.catalog.items.find((it) => it.episodeTitles)
  const noPoster = data.catalog.items.find((it) => !it.poster)
  const noBackdrop = data.catalog.items.find((it) => !it.backdrop)
  const hist = continuing()[0] || data.catalog.user.history[0]

  const colors = sec(
    'color',
    '颜色',
    row('背景', swatches([['--c-bg', '窗口底色'], ['--c-surface', '图片占位、骨架'], ['--c-raised', '菜单、弹层、对话框'], ['--c-raised-2', '提示、弹层内悬停']])) +
      row('填充', swatches([['--c-fill', '悬停'], ['--c-fill-2', '选中、次级按钮'], ['--c-fill-3', '次级按钮悬停']])) +
      row('线', swatches([['--c-line', '分隔线、细边'], ['--c-line-2', '悬停时的边']])) +
      row('文字', swatches([['--c-text', '标题、正文'], ['--c-text-2', '次要信息'], ['--c-text-3', '辅助信息、占位符'], ['--c-text-4', '禁用、分隔点']])) +
      row('主操作', swatches([['--c-primary', '主按钮'], ['--c-primary-hover', '主按钮悬停'], ['--c-on-primary', '主按钮上的字']])) +
      row('强调', swatches([['--c-accent', '只表示状态'], ['--c-accent-hover', ''], ['--c-accent-soft', '当前集的底'], ['--c-on-accent', '竹青上的字']])) +
      row('专用', swatches([['--c-score', '只给评分'], ['--c-danger', '只给删除、错误'], ['--c-danger-soft', ''], ['--c-close-hover', '只给窗口关闭']])) +
      row('玻璃', swatches([['--c-glass', '顶栏'], ['--c-glass-strong', '轻提示、面板'], ['--c-scrim', '对话框背后'], ['--c-media-dim', '图片上的小控件']])),
  )

  const sizes = ['--fs-12', '--fs-13', '--fs-14', '--fs-15', '--fs-16', '--fs-18', '--fs-20', '--fs-24', '--fs-32', '--fs-display-2', '--fs-display-1']
  const roles = [
    ['t-display-1', '首页主推片名'],
    ['t-display-2', '详情页片名'],
    ['t-title-1', '页面标题'],
    ['t-title-2', '栏目标题'],
    ['t-title-3', '小标题'],
    ['t-body-lg', '主推简介'],
    ['t-body', '正文'],
    ['t-label', '按钮、标签'],
    ['t-meta', '次要信息'],
    ['t-caption', '辅助信息'],
  ]
  const type = sec(
    'type',
    '文字',
    row('无衬线', `<p class="kit__font" style="font-family:var(--font-sans)">雾港来信 Panda 0123456789</p>`) +
      row('衬线', `<p class="kit__font" style="font-family:var(--font-serif);font-weight:700">雾港来信 山海绘卷 长夜将明</p>`) +
      row('字号', `<div class="kit__sizes">${sizes.map((s) => `<code>${s}</code><span style="font-size:var(${s})">一封迟到二十年的信</span>`).join('')}</div>`) +
      row('文字角色', `<div class="kit__sizes">${roles.map(([cls, note]) => `<code>.${cls}</code><span class="${cls}">${note}</span>`).join('')}</div>`),
  )

  const sp = ['--sp-05', '--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--sp-6', '--sp-8', '--sp-10', '--sp-12', '--sp-16', '--sp-20', '--sp-24']
  const radii = [['--r-xs', '角标、缩略图'], ['--r-sm', '格子、菜单项'], ['--r-md', '海报、卡片'], ['--r-lg', '浮层、面板'], ['--r-xl', '对话框'], ['--r-full', '独立控件']]
  const shape = sec(
    'shape',
    '间距 · 圆角 · 阴影',
    row('间距', `<div class="kit__spaces">${sp.map((s) => `<code>${s}</code><i style="width:var(${s})"></i><span data-value="${s}"></span>`).join('')}</div>`) +
      row('圆角', `<div class="kit__boxes">${radii.map(([r, note]) => `<div><i style="border-radius:var(${r})"></i><code>${r}</code><em>${note}</em></div>`).join('')}</div>`) +
      row('阴影', `<div class="kit__boxes">${['--sh-1', '--sh-2', '--sh-3', '--sh-4'].map((s) => `<div><i class="kit__raised" style="box-shadow:var(${s})"></i><code>${s}</code></div>`).join('')}</div>`) +
      row(
        '动效',
        tokenRows([
          ['--dur-1', '颜色、按压'],
          ['--dur-2', '提示、菜单等小元素'],
          ['--dur-3', '面板、页面'],
          ['--dur-4', '图片缩放、主推文字入场'],
          ['--dur-5', '主推背景交叉淡入'],
          ['--ease-out', '默认'],
          ['--ease-in-out', '位移'],
          ['--ease-pop', '只给收藏打勾'],
        ]),
      ) +
      row(
        '布局',
        tokenRows([
          ['--bar-h', '顶栏高度'],
          ['--gutter', '页面左右留白'],
          ['--gap', '卡片间距'],
          ['--shelf-gap', '栏目之间'],
          ['--cols-poster', '每行竖版卡片数（随窗口宽度变化）'],
          ['--cols-wide', '每行横版卡片数（随窗口宽度变化）'],
        ]),
      ),
  )

  const icons = sec('icon', '图标', `<div class="kit__icons" data-icons></div>`)

  const buttons = sec(
    'button',
    '按钮',
    row('主按钮', `<button class="btn btn--primary btn--lg">${icon('play')}${esc(c.action.play)}</button><button class="btn btn--primary">${icon('play')}${esc(c.action.play)}</button><button class="btn btn--primary btn--sm">${esc(c.player.playNow)}</button><button class="btn btn--primary" disabled>${esc(c.action.play)}</button>`) +
      row('次级按钮', `<button class="btn btn--lg">${esc(c.action.detail)}</button><button class="btn">${esc(c.action.detail)}</button><button class="btn btn--sm">${esc(c.action.clear)}</button><button class="btn" disabled>${esc(c.action.detail)}</button>`) +
      row('玻璃按钮', `${favoriteButton(sample.id)}<button class="btn btn--glass">${esc(c.player.skipIntro)}</button>`, 'kit__cell--media') +
      row('幽灵 / 危险', `<button class="btn btn--ghost">${esc(c.action.cancel)}</button><button class="btn btn--danger">${esc(c.action.clear)}</button>`) +
      row('图标按钮', `<button class="icon-btn icon-btn--lg" ${tip(c.action.back, 'Esc')}>${icon('arrow-left')}</button><button class="icon-btn" ${tip(c.nav.settings)}>${icon('settings')}</button><button class="icon-btn icon-btn--sm" ${tip(c.action.close)}>${icon('close', 'sm')}</button><button class="icon-btn" aria-current="page" ${tip(c.nav.me)}>${icon('user')}</button><button class="icon-btn icon-btn--media" ${tip(c.action.remove)}>${icon('close')}</button>`) +
      row('文字按钮', `<a class="text-btn" href="#/kit">${esc(c.action.more)}${icon('chevron-right')}</a><button class="text-btn">${esc(c.action.clear)}</button><button class="text-btn text-btn--strong">${esc(c.action.expand)}</button>`),
  )

  const forms = sec(
    'form',
    '选择与输入',
    row('筛选项', `<button class="chip" aria-pressed="true">${esc(c.channel.all)}</button><button class="chip" aria-pressed="false">悬疑</button><button class="chip" aria-pressed="false">科幻</button><a class="chip chip--solid" href="#/kit">雾港来信</a>`) +
      row('角标 / 按键', `<span class="tag">独播</span><span class="tag">首播</span><kbd class="kbd">Ctrl K</kbd><kbd class="kbd">Esc</kbd>`) +
      row(
        '输入框',
        `<label class="field kit__field">${icon('search', 'sm', 'field__icon')}<input class="field__input" placeholder="${esc(c.search.placeholder)}"><kbd class="kbd field__hint">Ctrl K</kbd></label>
         <label class="field kit__field" data-filled>${icon('search', 'sm', 'field__icon')}<input class="field__input" value="雾港"><button class="field__clear" type="button" aria-label="${esc(c.action.clearInput)}">${icon('close', 'sm')}</button></label>`,
      ) +
      row('开关', `<button class="switch" role="switch" aria-checked="false" data-unchecked aria-label="${esc(c.settings.autoNext)}"><span class="switch__thumb"></span></button><button class="switch" role="switch" aria-checked="true" data-checked aria-label="${esc(c.settings.autoNext)}"><span class="switch__thumb"></span></button><button class="switch" role="switch" aria-checked="true" data-checked data-disabled aria-label="${esc(c.settings.autoNext)}"><span class="switch__thumb"></span></button>`) +
      row('下拉', `<button class="select" data-menu="quality"><span>1080P</span>${icon('chevron-down', 'sm')}</button>`) +
      row('滑杆', `<div class="slider kit__slider"><div class="slider__control"><div class="slider__track"><div class="slider__range" style="width:62%"></div><div class="slider__thumb" style="position:absolute;top:50%;left:62%;translate:-50% -50%"></div></div></div></div>`) +
      row('标签页', tabs([['a', c.me.favorites], ['b', c.me.history]], 'a', { variant: 'title' })) +
      row('', tabs([['a', '1-50'], ['b', '51-100'], ['c', '101-150']], 'a')) +
      row('', tabs([['a', c.channel.sortHot], ['b', c.channel.sortNew], ['c', c.channel.sortScore]], 'a', { variant: 'plain' })),
  )

  const content = sec(
    'content',
    '内容',
    row('信息行', metaRow(sample, { region: true, max: 3 })) +
      row('卡片', `<div class="kit__cards">${posterCard(sample)}${noPoster ? posterCard(noPoster) : ''}${skeletonCard()}</div>`) +
      row('横版卡片', `<div class="kit__cards kit__cards--wide">${wideCard(wide)}${continueCard(hist)}${noBackdrop ? wideCard(noBackdrop) : ''}${skeletonCard(true)}</div>`) +
      row('选集', `<div class="eps kit__eps">${episodeCells(sample, 5, { to: 12 })}</div>`) +
      row('', `<div class="eplist eplist--cols kit__eps">${episodeCells(titled, 3, { to: 6 })}</div>`) +
      row('加载', `<span class="spinner"></span><span class="spinner spinner--sm"></span>`) +
      row('空状态', empty('bookmark', c.me.emptyFavorites)) +
      row('出错', empty('cloud-off', c.state.error, `<button class="btn">${esc(c.action.retry)}</button>`)),
  )

  const overlays = sec(
    'overlay',
    '浮层',
    row('提示', `<button class="icon-btn" ${tip(c.player.fullscreen, 'F')}>${icon('fullscreen')}</button><button class="icon-btn" ${tip(c.player.pip)}>${icon('pip')}</button><button class="icon-btn" ${tip(c.player.mute, 'M')}>${icon('volume')}</button>`) +
      row('菜单', `<button class="btn btn--ghost" data-menu="speed">${esc(c.player.speed)}</button>`) +
      row('对话框', `<button class="btn" data-dialog>${esc(c.settings.clearHistory)}</button>`) +
      row('轻提示', `<button class="btn" data-toast>${esc(c.toast.favorited)}</button><button class="btn" data-toast="undo">${esc(c.toast.removed)}</button>`),
  )

  const pid = `${hist.id}/${hist.episode}`
  const states = sec(
    'state',
    '状态与样例',
    row(
      '播放页',
      [['paused', '暂停'], ['waiting', '缓冲'], ['error', '出错'], ['skip', '跳过片头'], ['upnext', '即将播放'], ['panel', '选集面板']].map(([s, text]) => `<a class="chip chip--solid" href="#/play/${pid}?state=${s}">${text}</a>`).join(''),
    ) +
      row(
        '降级',
        `${noPoster ? `<a class="chip chip--solid" href="#/detail/${noPoster.id}">没有海报</a>` : ''}${noBackdrop ? `<a class="chip chip--solid" href="#/detail/${noBackdrop.id}">没有剧照</a>` : ''}<a class="chip chip--solid" href="#/search?q=${encodeURIComponent('不存在')}">搜索无结果</a><a class="chip chip--solid" href="#/channel/tv?genre=${encodeURIComponent('古装')}&region=${encodeURIComponent('韩国')}">筛选无结果</a>`,
      ) +
      row('演示数据', `<button class="btn btn--sm" data-reset>恢复初始数据</button>`),
  )

  el.innerHTML = `<main class="page kit">
    <header class="page__head"><h1 class="page__title">规格</h1></header>
    <nav class="kit__nav">${[['color', '颜色'], ['type', '文字'], ['shape', '间距 · 圆角 · 阴影'], ['icon', '图标'], ['button', '按钮'], ['form', '选择与输入'], ['content', '内容'], ['overlay', '浮层'], ['state', '状态与样例']].map(([id, text]) => `<button class="chip" data-jump="kit-${id}">${text}</button>`).join('')}</nav>
    ${colors}${type}${shape}${icons}${buttons}${forms}${content}${overlays}${states}
  </main>`

  // 令牌的实际取值
  const cs = getComputedStyle(document.documentElement)
  for (const s of $$('[data-value]', el)) s.textContent = cs.getPropertyValue(s.dataset.value).trim()
  window.addEventListener('resize', onResize)
  function onResize() {
    for (const s of $$('[data-value^="--cols"], [data-value="--gutter"]', el)) s.textContent = cs.getPropertyValue(s.dataset.value).trim()
  }

  // 图标：直接读图标表
  fetch('/icons/sprite.svg')
    .then((r) => r.text())
    .then((svg) => {
      const names = [...svg.matchAll(/<symbol id="([\w-]+)"/g)].map((m) => m[1])
      $('[data-icons]', el).innerHTML = names.map((n) => `<div class="kit__icon">${icon(n, 'lg')}<code>${n}</code></div>`).join('')
    })

  el.addEventListener('click', async (e) => {
    const jump = e.target.closest('[data-jump]')
    if (jump) return document.getElementById(jump.dataset.jump).scrollIntoView({ behavior: 'smooth', block: 'start' })
    const chip = e.target.closest('.kit__cell > .chip[aria-pressed]')
    if (chip) for (const s of $$('.chip[aria-pressed]', chip.parentElement)) s.setAttribute('aria-pressed', s === chip)
    const sw = e.target.closest('.switch:not([data-disabled])')
    if (sw) {
      const on = sw.toggleAttribute('data-checked')
      sw.toggleAttribute('data-unchecked', !on)
      sw.setAttribute('aria-checked', on)
    }
    const tab = e.target.closest('.tabs__tab')
    if (tab) setTab(tab.parentElement, tab.dataset.tab)
    const menu = e.target.closest('[data-menu]')
    if (menu) {
      const speed = menu.dataset.menu === 'speed'
      openMenu(menu, {
        label: speed ? c.player.speed : undefined,
        items: speed ? ['0.75×', '1.0×', '1.25×', '1.5×', '2.0×'].map((v) => ({ value: v, label: v })) : ['4K', '1080P', '720P', '480P'].map((v) => ({ value: v, label: v })),
        value: speed ? '1.0×' : menu.firstElementChild.textContent,
        align: speed ? 'center' : 'start',
        onSelect: (v) => speed || (menu.firstElementChild.textContent = v),
      })
    }
    if (e.target.closest('[data-dialog]')) await confirmDialog({ title: c.me.clearHistoryTitle, confirm: c.action.clear, danger: true })
    const ts = e.target.closest('[data-toast]')
    if (ts) toast(ts.dataset.toast ? c.toast.removed : c.toast.favorited, ts.dataset.toast ? { action: { label: c.action.undo, onClick() {} } } : {})
    if (e.target.closest('[data-reset]')) {
      store.reset()
      location.reload()
    }
  })

  return { cleanup: () => window.removeEventListener('resize', onResize) }
}

export { syncTabs }
