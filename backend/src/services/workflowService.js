import { query, insert } from '../db.js'
import { ApiError } from '../middleware/error.js'
import { assertClientAccess } from '../middleware/auth.js'
import { nowIso } from '../lib/dates.js'
import { bumpDash } from './dashboardService.js'

async function loadCaseForWrite(user, caseId) {
  const rows = await query('SELECT id, client_id FROM cases WHERE id = ?', [caseId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '案件不存在')
  assertClientAccess(user, rows[0].client_id)
  return rows[0]
}

export async function addDeadline(user, caseId, { dtype, due_date, note = '' } = {}) {
  if (!dtype || !due_date) throw new ApiError(400, 'BAD_REQUEST', '缺少必填字段：dtype / due_date')
  await loadCaseForWrite(user, caseId)
  const id = await insert('INSERT INTO deadlines (case_id, dtype, due_date, status, note, created_at) VALUES (?,?,?,?,?,?)', [
    caseId,
    dtype,
    due_date,
    '待处理',
    note,
    nowIso(),
  ])
  await bumpDash()
  return { id }
}

// 幂等：重复完成返回当前状态，不报错（离线重试安全）
export async function completeDeadline(user, deadlineId) {
  const rows = await query('SELECT dl.*, c.client_id FROM deadlines dl JOIN cases c ON c.id = dl.case_id WHERE dl.id = ?', [deadlineId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '期限不存在')
  assertClientAccess(user, rows[0].client_id)
  if (rows[0].status !== '已完成') {
    await query("UPDATE deadlines SET status = '已完成', completed_at = ? WHERE id = ?", [nowIso(), deadlineId])
    await bumpDash()
  }
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
