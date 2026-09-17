import { query, insert } from '../db.js'
import { ApiError } from '../middleware/error.js'
import { assertClientAccess } from '../middleware/auth.js'
import { nowIso } from '../lib/dates.js'
import { computeDueDate } from '../lib/deadlines.js'
import { getFirmContext, localToday } from './settingsService.js'
import { bumpDash } from './dashboardService.js'

async function loadCaseForWrite(user, caseId) {
  const rows = await query('SELECT id, client_id FROM cases WHERE id = ?', [caseId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '案件不存在')
  assertClientAccess(user, rows[0].client_id)
  return rows[0]
}

// 手工登记期限：同样支持两种起算口径 × 三种天数口径；或直接指定到期日。
export async function addDeadline(user, caseId, body = {}) {
  const { dtype, note = '' } = body
  if (!dtype) throw new ApiError(400, 'BAD_REQUEST', '缺少必填字段：dtype（事项名称）')
  await loadCaseForWrite(user, caseId)

  const manual = Boolean(body.due_date)
  let dueDate = body.due_date || null
  let baseType = null
  let baseDate = null
  let dayBasis = null
  let windowValue = null
  let windowUnit = null
  let receivePresumed = 0
  let rolled = 0

  const ctx = await getFirmContext()
  if (manual) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new ApiError(400, 'BAD_REQUEST', '到期日格式应为 YYYY-MM-DD')
    baseType = 'manual'
  } else {
    const dispatchDate = body.dispatch_date
    const base_type = body.base_type === 'dispatch' ? 'dispatch' : body.base_type === 'receive' ? 'receive' : null
    const n = Math.trunc(Number(body.window_value) || 0)
    const unit = body.window_unit === 'month' ? 'month' : 'day'
    const basis = ['natural', 'workday', 'legal'].includes(body.day_basis) ? body.day_basis : 'natural'
    if (!dispatchDate) throw new ApiError(400, 'BAD_REQUEST', '推算期限需提供官文发文日（或直接指定到期日）')
    if (!base_type) throw new ApiError(400, 'BAD_REQUEST', '请选择起算口径：自收到日 / 自发文日')
    if (n <= 0) throw new ApiError(400, 'BAD_REQUEST', '请填写大于 0 的期限长度')
    let receiveDate = body.receive_date || null
    if (receiveDate && !/^\d{4}-\d{2}-\d{2}$/.test(receiveDate)) throw new ApiError(400, 'BAD_REQUEST', '实际收到日格式应为 YYYY-MM-DD')
    if (receiveDate && receiveDate < dispatchDate) throw new ApiError(400, 'BAD_REQUEST', '实际收到日不能早于发文日')
    const r = computeDueDate({
      dispatch_date: dispatchDate,
      receive_date: receiveDate,
      presumed_days: Number(body.presumed_days) || 15,
      base_type,
      window_value: n,
      window_unit: unit,
      day_basis: basis,
      calendarOverride: ctx.calendarOverride,
    })
    dueDate = r.due_date
    baseType = base_type
    baseDate = r.base_date
    dayBasis = basis
    windowValue = n
    windowUnit = unit
    receivePresumed = r.receive_presumed ? 1 : 0
    rolled = r.rolled_forward ? 1 : 0
  }

  const id = await insert(
    `INSERT INTO deadlines
     (case_id, dtype, due_date, status, note, completed_at, created_at, source, base_type, base_date, day_basis, window_value, window_unit, receive_presumed, rolled_forward)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [caseId, dtype, dueDate, '待处理', note, null, nowIso(), 'manual', baseType, baseDate, dayBasis, windowValue, windowUnit, receivePresumed, rolled]
  )
  await bumpDash()
  return { id, due_date: dueDate, base_type: baseType, base_date: baseDate, day_basis: dayBasis, rolled_forward: !!rolled }
}

/**
 * 完成期限（幂等）。
 * 逾期完成必须二次确认并填写原因：body.reason 必填，写入 deadlines.overdue_reason 留痕；
 * body.confirmed 为二次确认标记，首次请求返回 409 NEED_OVERDUE_REASON 由前端弹确认框。
 */
export async function completeDeadline(user, deadlineId, body = {}) {
  const rows = await query('SELECT dl.*, c.client_id FROM deadlines dl JOIN cases c ON c.id = dl.case_id WHERE dl.id = ?', [deadlineId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '期限不存在')
  assertClientAccess(user, rows[0].client_id)
  const dl = rows[0]
  if (dl.status === '已完成') {
    return (await query('SELECT * FROM deadlines WHERE id = ?', [deadlineId]))[0]
  }
  const ctx = await getFirmContext()
  const today = localToday(ctx.timezone)
  const overdue = dl.due_date < today
  if (overdue) {
    const reason = (body?.reason || '').trim()
    if (!body?.confirmed || reason.length < 2) {
      throw new ApiError(409, 'NEED_OVERDUE_REASON', `该期限已于 ${dl.due_date} 到期（今日 ${today}）。逾期办结需二次确认并填写逾期原因，留痕备查。`, { due_date: dl.due_date, today })
    }
  }
  const reason = (body?.reason || '').trim()
  await query(
    `UPDATE deadlines SET status = '已完成', completed_at = ?, completed_by = ?, completed_by_name = ?, overdue_reason = ? WHERE id = ?`,
    [nowIso(), user.id, user.name, overdue ? reason : '', deadlineId]
  )
  await bumpDash()
  return (await query('SELECT * FROM deadlines WHERE id = ?', [deadlineId]))[0]
}

export async function addFee(user, caseId, { kind, amount, due_date } = {}) {
  if (!kind || amount == null || !due_date) throw new ApiError(400, 'BAD_REQUEST', '缺少必填字段：kind / amount / due_date')
  await loadCaseForWrite(user, caseId)
  const id = await insert('INSERT INTO fees (case_id, kind, amount, due_date, status, created_at) VALUES (?,?,?,?,?,?)', [
    caseId,
    kind,
    amount,
    due_date,
    '待缴',
    nowIso(),
  ])
  await bumpDash()
  return { id }
}

// 幂等：重复缴费返回当前状态
export async function payFee(user, feeId) {
  const rows = await query('SELECT f.*, c.client_id FROM fees f JOIN cases c ON c.id = f.case_id WHERE f.id = ?', [feeId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '费用记录不存在')
  assertClientAccess(user, rows[0].client_id)
  if (rows[0].status !== '已缴') {
    await query("UPDATE fees SET status = '已缴', paid_at = ? WHERE id = ?", [nowIso(), feeId])
    await bumpDash()
  }
  return (await query('SELECT * FROM fees WHERE id = ?', [feeId]))[0]
}
