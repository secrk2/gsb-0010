export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export function fmtDate(s) {
  return s ? String(s).slice(0, 10) : '—'
}

export function fmtDateTime(s) {
  if (!s) return '—'
  if (typeof s === 'number') {
    const d = new Date(s)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  return String(s).slice(0, 16)
}

export function fmtMoney(n) {
  return `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 0 })}`
}

// 到期日 → 徽标文案与样式
export function dday(dueDate) {
  const today = new Date().toISOString().slice(0, 10)
  const diff = Math.round((Date.parse(dueDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000)
  if (diff < 0) return { text: `逾期${-diff}天`, cls: 'bad' }
  if (diff === 0) return { text: '今天到期', cls: 'bad' }
  if (diff <= 3) return { text: `D-${diff}`, cls: 'bad' }
  if (diff <= 7) return { text: `D-${diff}`, cls: 'warn' }
  return { text: `D-${diff}`, cls: 'ok' }
}
