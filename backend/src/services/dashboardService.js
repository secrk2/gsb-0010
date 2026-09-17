import { query } from '../db.js'
import { redis } from '../redis.js'
import { daysFromNow } from '../lib/dates.js'
import { maskedName, isFirmRole } from '../lib/mask.js'
import { computeCompletion } from '../lib/completion.js'
import { getFirmContext, localToday } from './settingsService.js'

// 任何案件/期限/费用/客户/合同/官文变更后调用：版本号+1 使全部 dashboard 缓存失效
export async function bumpDash() {
  try {
    await redis().incr('dash:version')
  } catch {}
}

export async function getDashboard(user) {
  const v = (await redis().get('dash:version')) || '0'
  const scope = user.role === 'client_admin' ? `c${user.client_id}` : 'firm'
  const key = `dash:${v}:${user.role}:${scope}`
  try {
    const hit = await redis().get(key)
    if (hit) return JSON.parse(hit)
  } catch {}
  const data = await buildDashboard(user)
  try {
    await redis().set(key, JSON.stringify(data), 'EX', 20)
  } catch {}
  return data
}

// 在办状态：授权与驳回为结案（驳回仍可走复审，但口径上计入结案，与漏斗/导出一致）
const ACTIVE = ['申请', '受理', '初审', '实审', '复审', '无效']

async function buildDashboard(user) {
  const scoped = user.role === 'client_admin'
  const cid = scoped ? user.client_id : null
  const firm = isFirmRole(user.role)
  const ctx = await getFirmContext()
  const t = localToday(ctx.timezone)

  // ---- 各客户待处理漏斗（八态）----
  const clients = scoped
    ? await query('SELECT * FROM clients WHERE id = ?', [cid])
    : await query('SELECT * FROM clients ORDER BY id')
  const funnels = []
  for (const cl of clients) {
    const rows = await query('SELECT status, COUNT(*) AS n FROM cases WHERE client_id = ? GROUP BY status', [cl.id])
    const byStatus = {}
    for (const r of rows) byStatus[r.status] = Number(r.n)
    const active = rows.filter((r) => ACTIVE.includes(r.status)).reduce((s, r) => s + Number(r.n), 0)
    const pend = await query(
      `SELECT COUNT(*) AS n FROM deadlines dl JOIN cases c ON c.id = dl.case_id
       WHERE c.client_id = ? AND dl.status = '待处理' AND dl.voided = 0`,
      [cl.id]
    )
    const od = await query(
      "SELECT COUNT(*) AS n FROM fees f JOIN cases c ON c.id = f.case_id WHERE c.client_id = ? AND f.status = '待缴' AND f.due_date < ?",
      [cl.id, t]
    )
    const masked = firm && active > 0
    funnels.push({
      client_id: cl.id,
      client_name: masked ? maskedName(cl) : cl.name,
      masked,
      by_status: byStatus,
      active_cases: active,
      pending_deadlines: Number(pend[0].n),
      overdue_fees: Number(od[0].n),
    })
  }

  // ---- 官文期限（30 天内 + 已逾期，按到期日升序；作废期限不展示）----
  const scopeWhere = scoped ? 'AND c.client_id = ?' : ''
  const horizon = daysFromNow(30, new Date())
  const dlParams = scoped ? [horizon, cid] : [horizon]
  const dlRows = await query(
    `SELECT dl.*, c.id AS case_id, c.case_no, c.title AS case_title, c.status AS case_status,
            cl.id AS client_id, cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code
     FROM deadlines dl JOIN cases c ON c.id = dl.case_id JOIN clients cl ON cl.id = c.client_id
     WHERE dl.status = '待处理' AND dl.voided = 0 AND dl.due_date <= ? ${scopeWhere}
     ORDER BY dl.due_date ASC LIMIT 50`,
    dlParams
  )
  const deadlines = []
  for (const r of dlRows) {
    deadlines.push({
      id: r.id,
      dtype: r.dtype,
      due_date: r.due_date,
      d_day: Math.round((Date.parse(r.due_date + 'T00:00:00Z') - Date.parse(t + 'T00:00:00Z')) / 86400000),
      overdue: r.due_date < t,
      note: r.note,
      base_type: r.base_type,
      base_date: r.base_date,
      day_basis: r.day_basis,
      receive_presumed: !!r.receive_presumed,
      rolled_forward: !!r.rolled_forward,
      case_id: r.case_id,
      case_no: r.case_no,
      case_title: r.case_title,
      client_name: firm && r.case_status !== '申请' ? `${r.client_short_code}·${r.client_code}` : r.client_name,
    })
  }

  // ---- 缴费逾期（红点）----
  const feeParams = scoped ? [t, cid] : [t]
  const feeRows = await query(
    `SELECT f.id, f.kind, f.amount, f.due_date, c.id AS case_id, c.case_no, c.title AS case_title, c.status AS case_status,
            cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code
     FROM fees f JOIN cases c ON c.id = f.case_id JOIN clients cl ON cl.id = c.client_id
     WHERE f.status = '待缴' AND f.due_date < ? ${scopeWhere}
     ORDER BY f.due_date ASC LIMIT 50`,
    feeParams
  )
  const overdueFees = feeRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amount: Number(r.amount),
    due_date: r.due_date,
    overdue_days: Math.round((Date.parse(t + 'T00:00:00Z') - Date.parse(r.due_date + 'T00:00:00Z')) / 86400000),
    case_id: r.case_id,
    case_no: r.case_no,
    case_title: r.case_title,
    client_name: firm && r.case_status !== '申请' ? `${r.client_short_code}·${r.client_code}` : r.client_name,
  }))

  // ---- 案件完成度（双口径，作战台/详情/导出同源）----
  const caseParams = scoped ? [cid] : []
  const caseRows = await query(
    `SELECT c.id, c.case_no, c.title, c.status, c.client_id,
            cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code,
            u.name AS agent_name
     FROM cases c JOIN clients cl ON cl.id = c.client_id LEFT JOIN users u ON u.id = c.agent_id
     ${scoped ? 'WHERE c.client_id = ?' : ''}
     ORDER BY c.updated_at DESC, c.id DESC LIMIT 100`,
    caseParams
  )
  const completion = []
  for (const c of caseRows) {
    const oas = await query('SELECT oa_type, status FROM office_actions WHERE case_id = ?', [c.id])
    completion.push({
      case_id: c.id,
      case_no: c.case_no,
      case_title: c.title,
      case_status: c.status,
      agent_name: c.agent_name,
      client_name: firm && c.status !== '申请' ? `${c.client_short_code}·${c.client_code}` : c.client_name,
      completion: computeCompletion({ officeActions: oas, caseStatus: c.status }),
    })
  }

  // ---- KPI ----
  const kpiParams = scoped ? [cid] : []
  const activeCases = await query(
    `SELECT COUNT(*) AS n FROM cases ${scoped ? 'WHERE client_id = ? AND' : 'WHERE'} status IN ('申请','受理','初审','实审','复审','无效')`,
    kpiParams
  )
  const soon7 = deadlines.filter((d) => !d.overdue && d.d_day <= 7).length
  const overdueDl = deadlines.filter((d) => d.overdue).length

  return {
    generated_at: new Date().toISOString(),
    timezone: ctx.timezone,
    local_today: t,
    kpi: {
      active_cases: Number(activeCases[0].n),
      pending_deadlines: deadlines.length,
      due_in_7d: soon7,
      overdue_deadlines: overdueDl,
      overdue_fees: overdueFees.length,
      overdue_fee_amount: overdueFees.reduce((s, f) => s + f.amount, 0),
    },
    funnels,
    deadlines,
    overdue_fees: overdueFees,
    completion,
  }
}
