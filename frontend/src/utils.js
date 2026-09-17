export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// ---------- 日期 ----------
// 后端所有日期为 UTC 存储；日期串（Y-M-D）是代理所时区下的「当地日」，直接展示；
// 时刻串（Y-M-D HH:MM:SS，UTC）按代理所时区换算后展示。
export function fmtDate(s) {
  return s ? String(s).slice(0, 10) : '—'
}

export function fmtDateTime(s, timezone) {
  if (!s) return '—'
  if (typeof s === 'number') return fmtDateTime(new Date(s).toISOString(), timezone)
  const normalized = /T/.test(s) ? s : s.replace(' ', 'T') + 'Z'
  const d = new Date(normalized)
  if (Number.isNaN(d.getTime())) return String(s).slice(0, 16)
  const p = (n) => String(n).padStart(2, '0')
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(d)
      const get = (t) => parts.find((x) => x.type === t)?.value
      return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
    } catch {}
  }
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

export function fmtMoney(n) {
  return `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 0 })}`
}

// ---------- 期限口径文案 ----------
export const BASE_TYPE_LABELS = {
  receive: '自收到日起算',
  dispatch: '自发文日起算',
  manual: '指定到期日',
}

export const DAY_BASIS_LABELS = {
  natural: '自然日',
  workday: '工作日（剔周末）',
  legal: '法定节假日口径（剔周末与法定假日、计调休）',
}

// 期限一行口径说明：起算口径 + 起算日 + 是否推定收到 + 天数口径 + 是否顺延
export function basisText(d) {
  if (!d.base_type) return ''
  if (d.base_type === 'manual') return '指定到期日（未推算）'
  const bits = []
  bits.push(d.base_type === 'receive'
    ? `自${d.receive_presumed ? '推定' : ''}收到日 ${d.base_date} 起算`
    : `自发文日 ${d.base_date} 起算`)
  if (d.window_value) bits.push(`${d.window_value} ${d.window_unit === 'month' ? '个月' : '天'} · ${DAY_BASIS_LABELS[d.day_basis] || d.day_basis}`)
  if (d.rolled_forward) bits.push('到期日遇法定假日已顺延')
  return bits.join('，')
}

// 到期日 → 徽标文案与样式（today 由后端按代理所时区给出，跨时区不错一天）
export function dday(dueDate, today = new Date().toISOString().slice(0, 10)) {
  const diff = Math.round((Date.parse(dueDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000)
  if (diff < 0) return { text: `逾期${-diff}天`, cls: 'bad', diff }
  if (diff === 0) return { text: '今天到期', cls: 'bad', diff }
  if (diff <= 3) return { text: `D-${diff}`, cls: 'bad', diff }
  if (diff <= 7) return { text: `D-${diff}`, cls: 'warn', diff }
  return { text: `D-${diff}`, cls: 'ok', diff }
}

// ---------- 日历网格 ----------
const parseDate = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
const toDateStr = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

// 月视图：包含该月的 6 行 × 7 列（周一开头），from=本周一
export function monthGrid(anchor) {
  const d = parseDate(anchor)
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  const startOffset = (first.getUTCDay() + 6) % 7 // 周一=0
  const start = new Date(first)
  start.setUTCDate(1 - startOffset)
  const days = []
  for (let i = 0; i < 42; i++) {
    const cur = new Date(start)
    cur.setUTCDate(start.getUTCDate() + i)
    days.push(toDateStr(cur))
  }
  return { days, from: days[0], to: days[41], title: `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月` }
}

// 周视图：anchor 所在周（周一至周日）
export function weekRange(anchor) {
  const d = parseDate(anchor)
  const offset = (d.getUTCDay() + 6) % 7
  const monday = new Date(d)
  monday.setUTCDate(d.getUTCDate() - offset)
  const days = []
  for (let i = 0; i < 7; i++) {
    const cur = new Date(monday)
    cur.setUTCDate(monday.getUTCDate() + i)
    days.push(toDateStr(cur))
  }
  return { days, from: days[0], to: days[6], title: `${days[0].slice(5)} ~ ${days[6].slice(5)}` }
}

export function shiftMonth(anchor, delta) {
  const d = parseDate(anchor)
  d.setUTCMonth(d.getUTCMonth() + delta)
  return toDateStr(d)
}
export function shiftWeek(anchor, delta) {
  const d = parseDate(anchor)
  d.setUTCDate(d.getUTCDate() + delta * 7)
  return toDateStr(d)
}

export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

// ---------- 完成度 ----------
export const COMPLETION_HINT = {
  documents: '已归档官文数 ÷ 必经主线官文（受理/初审公布/进入实审/审查结论 = 4）。多通意见会抬高本口径，封顶 100%。',
  stages: '已完成关键阶段 ÷ 5（受理→初审→实审→审查结论→程序终结）。半截官文不会抬高本口径。',
}

export function completionText(c) {
  if (!c) return ''
  return `官文 ${c.documents.percent}%（${c.documents.done}/${c.documents.total}）· 阶段 ${c.stages.percent}%（${c.stages.done}/${c.stages.total}）`
}
