import { query, tx, isDupErr } from '../db.js'
import { ApiError } from '../middleware/error.js'
import { assertClientAccess } from '../middleware/auth.js'
import { checkTransition, allowedTransitionsFor, isOaAllowedAtStage } from '../lib/stateMachine.js'
import { OA_TYPES, OA_TYPE_OPTIONS } from '../lib/oaCatalog.js'
import { isFirmRole } from '../lib/mask.js'
import { nowIso } from '../lib/dates.js'
import { bumpDash } from './dashboardService.js'
import { getFirmContext, localToday } from './settingsService.js'
import { getCompletion, presentDeadline } from './officeActionService.js'

function presentCase(r, user) {
  const masked = isFirmRole(user.role) && r.status !== '申请'
  return {
    id: r.id,
    case_no: r.case_no,
    client_uuid: r.client_uuid,
    client_id: r.client_id,
    client_name: masked ? `${r.client_short_code}·${r.client_code}` : r.client_name,
    client_masked: masked,
    contract_id: r.contract_id,
    title: r.title,
    ctype: r.ctype,
    status: r.status,
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    priority: r.priority,
    version: r.version,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

const CASE_SELECT = `SELECT c.*, cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code,
                     u.name AS agent_name
                     FROM cases c JOIN clients cl ON cl.id = c.client_id LEFT JOIN users u ON u.id = c.agent_id`

// 列表附带完成度（双口径），作战台/列表/导出同源
export async function listCasesWithCompletion(user, rows) {
  const ctx = await getFirmContext()
  return Promise.all(rows.map(async (r) => {
    const item = presentCase(r, user)
    item.completion = await getCompletion(r.id, r.status)
    item.timezone = ctx.timezone
    return item
  }))
}

export async function listCases(user, { status, client_id, mine } = {}) {
  const conds = []
  const params = []
  if (user.role === 'client_admin') {
    conds.push('c.client_id = ?')
    params.push(user.client_id)
  } else if (client_id) {
    conds.push('c.client_id = ?')
    params.push(client_id)
  }
  if (status) {
    conds.push('c.status = ?')
    params.push(status)
  }
  if (mine) {
    conds.push('c.agent_id = ?')
    params.push(user.id)
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
  const rows = await query(`${CASE_SELECT} ${where} ORDER BY c.updated_at DESC, c.id DESC LIMIT 500`, params)
  return listCasesWithCompletion(user, rows)
}

// 当前角色在当前阶段可登记的官文类型：官文类型必须与该条状态边或该程序阶段匹配（杜绝绕过程序的跃迁）
export function registerableOaTypes(status, role, isAssignee) {
  return OA_TYPE_OPTIONS.filter((o) => isOaAllowedAtStage(o.key, o.target, status, role, isAssignee)).map((o) => ({
    key: o.key,
    label: o.label,
    target: o.target,
    deadlines: (OA_TYPES[o.key].deadlines || []).map((d) => ({ ...d })),
  }))
}

export async function getCaseDetail(user, caseId) {
  const rows = await query(`${CASE_SELECT} WHERE c.id = ?`, [caseId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '案件不存在')
  const c = rows[0]
  assertClientAccess(user, c.client_id)
  const events = await query('SELECT * FROM case_events WHERE case_id = ? ORDER BY id ASC', [caseId])
  const deadlines = await query('SELECT * FROM deadlines WHERE case_id = ? ORDER BY due_date ASC, id ASC', [caseId])
  const fees = await query('SELECT * FROM fees WHERE case_id = ? ORDER BY due_date ASC', [caseId])
  const officeActions = await query('SELECT * FROM office_actions WHERE case_id = ? ORDER BY dispatch_date DESC, id DESC', [caseId])
  const contracts = await query('SELECT id, contract_no, title, status, signed_at FROM contracts WHERE client_id = ?', [c.client_id])
  const isAssignee = c.agent_id === user.id
  const ctx = await getFirmContext()
  const today = localToday(ctx.timezone)
  const dlView = await Promise.all(deadlines.map((d) => presentDeadline(d, { timezone: ctx.timezone, today })))
  return {
    ...presentCase(c, user),
    contract_no: contracts[0]?.contract_no || null,
    events,
    deadlines: dlView,
    office_actions: officeActions.map((o) => ({
      id: o.id,
      oa_type: o.oa_type,
      oa_type_label: OA_TYPES[o.oa_type]?.label || o.oa_type,
      doc_no: o.doc_no,
      dispatch_date: o.dispatch_date,
      receive_date: o.receive_date,
      presumed_days: o.presumed_days,
      receive_presumed: !!o.receive_presumed,
      target_status: o.target_status,
      status: o.status,
      withdraw_reason: o.withdraw_reason,
      note: o.note,
      created_by_name: o.created_by_name,
      created_at: o.created_at,
      withdrawn_at: o.withdrawn_at,
      withdrawn_by_name: o.withdrawn_by_name,
      deadlines: dlView.filter((d) => d.office_action_id === o.id),
    })),
    fees: fees.map((f) => ({ ...f, amount: Number(f.amount), overdue: f.status === '待缴' && f.due_date < today })),
    completion: await getCompletion(caseId, c.status),
    allowed_transitions: allowedTransitionsFor(c.status, user.role, isAssignee),
    registerable_oa: isFirmRole(user.role) ? registerableOaTypes(c.status, user.role, isAssignee) : [],
    can_reveal: isFirmRole(user.role) && c.status !== '申请',
    timezone: ctx.timezone,
    local_today: today,
  }
}

// 手动状态流转（异常更正入口）：仍受状态机白名单约束。正常流程一律走官文登记。
export async function transitionCase(user, caseId, { to, reason = '', agent_id = null } = {}) {
  const rows = await query('SELECT * FROM cases WHERE id = ?', [caseId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '案件不存在')
  const c = rows[0]
  assertClientAccess(user, c.client_id)
  const signed = await query("SELECT id FROM contracts WHERE client_id = ? AND status = '已签署'", [c.client_id])
  const chk = checkTransition({
    from: c.status,
    to,
    role: user.role,
    isAssignee: c.agent_id === user.id,
    hasContract: signed.length > 0,
    hasAgent: Boolean(agent_id || c.agent_id),
  })
  if (!chk.ok) throw new ApiError(chk.http, chk.code, chk.message)
  if (chk.noop) return { case: await getCaseDetail(user, caseId), noop: true }
  const finalAgent = agent_id ?? c.agent_id
  const now = nowIso()
  await tx(async (d) => {
    await d.query('UPDATE cases SET status = ?, agent_id = ?, version = version + 1, updated_at = ? WHERE id = ?', [
      to,
      finalAgent,
      now,
      caseId,
    ])
    await d.insert(
      'INSERT INTO case_events (case_id, from_status, to_status, action, actor_id, actor_name, reason, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [caseId, c.status, to, chk.label, user.id, user.name, reason, now]
    )
  })
  await bumpDash()
  return { case: await getCaseDetail(user, caseId) }
}

// 创建委托案件（尚未收到受理通知书，状态=申请）。client_uuid 由前端生成（离线场景先于本地存在），
// 数据库唯一约束兜底：断网重试/重复提交/批量同步重放都不会产生重复案件。
export async function createCase(user, payload) {
  const { client_uuid, client_id, title, ctype = '发明', priority = '普通', contract_id = null } = payload || {}
  if (!client_uuid || !client_id || !title) {
    throw new ApiError(400, 'BAD_REQUEST', '缺少必填字段：client_uuid / client_id / title')
  }
  assertClientAccess(user, Number(client_id))
  const clients = await query('SELECT id FROM clients WHERE id = ?', [client_id])
  if (!clients.length) throw new ApiError(404, 'NOT_FOUND', '客户不存在')
  if (contract_id) {
    const cs = await query('SELECT id FROM contracts WHERE id = ? AND client_id = ?', [contract_id, client_id])
    if (!cs.length) throw new ApiError(400, 'BAD_REQUEST', '合同不属于该客户')
  }
  const now = nowIso()
  try {
    const id = await tx(async (d) => {
      const newId = await d.insert(
        `INSERT INTO cases (case_no, client_uuid, client_id, contract_id, title, ctype, status, agent_id, priority, version, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [`TMP-${client_uuid}`, client_uuid, client_id, contract_id, title, ctype, '申请', null, priority, 1, user.id, now, now]
      )
      const caseNo = `AL-${now.slice(0, 4)}-${String(newId).padStart(4, '0')}`
      await d.query('UPDATE cases SET case_no = ? WHERE id = ?', [caseNo, newId])
      await d.insert(
        'INSERT INTO case_events (case_id, from_status, to_status, action, actor_id, actor_name, reason, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [newId, null, '申请', '创建申请', user.id, user.name, '', now]
      )
      return newId
    })
    await bumpDash()
    return { case: await getCaseDetail(user, id), deduped: false }
  } catch (e) {
    if (isDupErr(e)) {
      const rows = await query('SELECT id FROM cases WHERE client_uuid = ?', [client_uuid])
      if (rows.length) return { case: await getCaseDetail(user, rows[0].id), deduped: true }
    }
    throw e
  }
}
