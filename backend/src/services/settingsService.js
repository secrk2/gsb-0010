import { query } from '../db.js'
import { ApiError } from '../middleware/error.js'
import { nowIso } from '../lib/dates.js'

const DEFAULT_TZ = 'Asia/Shanghai'

// 代理所所级上下文：展示时区 + 库表中的节假日/调休覆盖。
// 所有期限日期以 UTC 日期串入库，「今天」与时刻展示按此时区换算，跨时区不错一天。
export async function getFirmContext() {
  const rows = await query('SELECT k, v FROM kv_settings').catch(() => [])
  const map = {}
  for (const r of rows) map[r.k] = r.v
  const hol = await query('SELECT date, kind FROM holidays').catch(() => [])
  return {
    timezone: map['firm.timezone'] || DEFAULT_TZ,
    calendarOverride: {
      holidays: hol.filter((h) => h.kind === 'holiday').map((h) => h.date),
      workdays: hol.filter((h) => h.kind === 'workday').map((h) => h.date),
    },
  }
}

// 以指定时区取当地「今天」（Y-M-D）。en-CA 语言环境稳定输出 YYYY-MM-DD。
export function localToday(timezone = DEFAULT_TZ, at = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at)
  } catch {
    return at.toISOString().slice(0, 10)
  }
}

// 将 UTC 存储的「YYYY-MM-DD HH:MM:SS」按代理所时区格式化为展示串
export function toLocalDisplay(utcText, timezone) {
  if (!utcText) return ''
  const normalized = /T/.test(utcText) ? utcText : utcText.replace(' ', 'T') + 'Z'
  const d = new Date(normalized)
  if (Number.isNaN(d.getTime())) return String(utcText).slice(0, 16)
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d)
  } catch {
    return String(utcText).slice(0, 16)
  }
}

export async function getSettings() {
  const ctx = await getFirmContext()
  return { timezone: ctx.timezone }
}

export async function updateSettings(user, { timezone } = {}) {
  if (timezone !== undefined) {
    if (!/^[A-Za-z_]+\/[A-Za-z_+-]+$/.test(timezone)) {
      throw new ApiError(400, 'BAD_REQUEST', '时区格式不正确，例如 Asia/Shanghai、Europe/London')
    }
    // 用 Intl 实测一次，拒绝 Node 不识别的时区
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric' })
    } catch {
      throw new ApiError(400, 'BAD_REQUEST', `系统不识别时区「${timezone}」`)
    }
    // 两种驱动没有统一 upsert 语法（MySQL 用 ON DUPLICATE KEY、sqlite 用 ON CONFLICT），直接 SELECT 后分支
    const exists = await query('SELECT k FROM kv_settings WHERE k = ?', ['firm.timezone'])
    if (exists.length) await query('UPDATE kv_settings SET v=?, updated_at=?, updated_by=? WHERE k=?', [timezone, nowIso(), user.id, 'firm.timezone'])
    else await query('INSERT INTO kv_settings (k, v, updated_at, updated_by) VALUES (?,?,?,?)', ['firm.timezone', timezone, nowIso(), user.id])
  }
  return getSettings()
}
