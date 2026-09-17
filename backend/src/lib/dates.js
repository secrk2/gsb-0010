// 统一使用 UTC ISO 字符串，MySQL 与 sqlite 下比较行为一致（字典序即时间序）
export function nowIso(d = new Date()) {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

export function today(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

export function daysFromNow(n, base = new Date()) {
  const d = new Date(base)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// b - a 的天数（a/b 均为 YYYY-MM-DD）
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
}
