// 期限引擎（纯函数，路由 / 离线合并 / 单测共用）。
//
// 两条「雷区」口径在此一处算清，界面只做展示：
//   1) 起算口径 base_type：
//        receive   —— 自收到日起算（推定收到日 = 发文日 + 推定送达天数，默认 15 日；
//                       实际签收日若登记则以实际为准）
//        dispatch  —— 自发文日起算
//        manual    —— 登记时直接指定到期日（不适用于自动推算）
//      发文日与收到日可能相差数日，界面必须明示用的是哪一个，代理人不靠猜。
//
//   2) 天数口径 day_basis：
//        natural  自然日（逐日累加）
//        workday  工作日（跳过周六日，不剔除法定假日）
//        legal    法定节假日口径（跳过周末与法定休假日、计入调休上班日）
//
// 期限单位 window_unit：day 日 / month 月（按月 = 起算日对应日，依法顺延规则见 addCalendarMonths）。
//
// 法定顺延（专利法实施细则 §5 精神）：到期日恰为法定休息日/节假日时，顺延至其后第一个工作日。
// natural 口径同样适用「到期日为法定假日则顺延」（官方期限通行做法）；workday 口径到期日天然为工作日，不顺延。

import { buildCalendar } from './holidays.js'

export const BASE_TYPES = {
  receive: { key: 'receive', label: '自收到日起算' },
  dispatch: { key: 'dispatch', label: '自发文日起算' },
  manual: { key: 'manual', label: '指定到期日（不推算）' },
}

export const DAY_BASIS = {
  natural: { key: 'natural', label: '自然日' },
  workday: { key: 'workday', label: '工作日（剔周末）' },
  legal: { key: 'legal', label: '法定节假日口径（剔周末与法定假日、计调休）' },
}

const pad = (n) => String(n).padStart(2, '0')
const toStr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const parse = (s) => new Date(`${s}T00:00:00Z`)
const addDays = (s, n) => {
  const d = parse(s)
  d.setUTCDate(d.getUTCDate() + n)
  return toStr(d)
}

// 推定收到日：发文日 + 推定送达天数（默认 15 日，自然日）。实际签收优先于推定。
export function presumedReceiveDate(dispatchDate, presumedDays = 15) {
  if (!dispatchDate) return null
  return addDays(dispatchDate, presumedDays)
}

/**
 * 实际收到日取值：登记了实际签收日用实际，否则用推定收到日。
 * @returns {{receive_date: string, presumed: boolean}}
 */
export function resolveReceiveDate({ dispatch_date, receive_date, presumed_days }) {
  if (receive_date) return { receive_date, presumed: false }
  return { receive_date: presumedReceiveDate(dispatch_date, presumed_days ?? 15), presumed: true }
}

// 加 N 个日历月：目标月无对应日（如 1/31 +1 月）取该月最后一天。
export function addCalendarMonths(dateStr, months) {
  const d = parse(dateStr)
  const day = d.getUTCDate()
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return toStr(target)
}

// 加 N 个工作日（仅跳周末）
function addWorkdays(dateStr, n) {
  let cur = dateStr
  let step = 0
  const dir = n >= 0 ? 1 : -1
  n = Math.abs(n)
  while (step < n) {
    cur = addDays(cur, dir)
    const day = parse(cur).getUTCDay()
    if (day !== 0 && day !== 6) step++
  }
  return cur
}

// 加 N 个「法定工作日」（跳周末 + 法定休假日，计调休上班日）
function addLegalDays(dateStr, n, cal) {
  let cur = dateStr
  let step = 0
  const dir = n >= 0 ? 1 : -1
  n = Math.abs(n)
  while (step < n) {
    cur = addDays(cur, dir)
    if (!cal.isLegalNonWorking(cur)) step++
  }
  return cur
}

// 法定顺延：到期日为法定休假日/休息日（且非调休上班日）→ 顺延至其后第一个法定工作日
function rollForward(dateStr, cal) {
  let cur = dateStr
  let guard = 0
  while (cal.isLegalNonWorking(cur) && guard < 60) {
    cur = addDays(cur, 1)
    guard++
  }
  return cur
}

/**
 * 推算期限到期日。
 * @param {object} spec
 * @param {string} [spec.dispatch_date]    发文日 YYYY-MM-DD
 * @param {string} [spec.receive_date]     实际收到/签收日（可空，空则推定）
 * @param {number} [spec.presumed_days=15] 推定送达天数
 * @param {'receive'|'dispatch'} spec.base_type
 * @param {number} spec.window_value       期限长度（正整数）
 * @param {'day'|'month'} [spec.window_unit='day']
 * @param {'natural'|'workday'|'legal'} [spec.day_basis='natural']
 * @param {{holidays?:string[],workdays?:string[]}} [spec.calendarOverride]
 * @returns {{base_date:string, base_date_kind:'receive'|'dispatch', receive_presumed:boolean, receive_date:string, due_date:string, rolled_forward:boolean}}
 */
export function computeDueDate(spec) {
  const cal = buildCalendar(spec.calendarOverride)
  const baseType = spec.base_type === 'dispatch' ? 'dispatch' : 'receive'
  const { receive_date, presumed } = resolveReceiveDate(spec)
  if (baseType === 'receive' && !receive_date) {
    throw new Error('自收到日起算缺少发文日或收到日')
  }
  if (baseType === 'dispatch' && !spec.dispatch_date) {
    throw new Error('自发文日起算缺少发文日')
  }
  const baseDate = baseType === 'receive' ? receive_date : spec.dispatch_date
  const n = Math.max(0, Math.trunc(Number(spec.window_value) || 0))
  const unit = spec.window_unit === 'month' ? 'month' : 'day'
  const basis = ['natural', 'workday', 'legal'].includes(spec.day_basis) ? spec.day_basis : 'natural'

  let raw
  if (unit === 'month') {
    raw = addCalendarMonths(baseDate, n)
  } else if (basis === 'workday') {
    raw = addWorkdays(baseDate, n)
  } else if (basis === 'legal') {
    raw = addLegalDays(baseDate, n, cal)
  } else {
    raw = addDays(baseDate, n)
  }

  // 法定顺延：自然日/按月期限落在法定休息日时顺延；工作日口径到期日本身就是工作日。
  let due = raw
  let rolled = false
  if (basis !== 'workday' && cal.isLegalNonWorking(raw)) {
    due = rollForward(raw, cal)
    rolled = due !== raw
  }
  return {
    base_date: baseDate,
    base_date_kind: baseType,
    receive_date,
    receive_presumed: baseType === 'receive' ? presumed : false,
    due_date: due,
    rolled_forward: rolled,
  }
}

/**
 * 剩余天数（「还剩几天」）。
 * 倒计时统一展示自然日差；三种天数口径的差异已经体现在 due_date 的推算上，不再二次换算以免代理人混淆。
 * 统一以 UTC 日期串计算，由前端按代理所时区传入「当地今天」，跨时区不会多一天少一天。
 * @returns {{days:number, overdue:boolean, today:string, due_date:string}}
 */
export function remainingDays(dueDate, todayStr) {
  const days = Math.round((parse(dueDate).getTime() - parse(todayStr).getTime()) / 86400000)
  return { days, overdue: days < 0, today: todayStr, due_date: dueDate }
}
