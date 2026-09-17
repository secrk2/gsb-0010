import { query } from '../db.js'
import { redis } from '../redis.js'
import { today, daysFromNow, daysBetween } from '../lib/dates.js'
import { maskedName, isFirmRole } from '../lib/mask.js'

// 任何案件/期限/费用/客户/合同变更后调用：版本号+1 使全部 dashboard 缓存失效
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

async function buildDashboard(user) {
  const scoped = user.role === 'client_admin'
  const cid = scoped ? user.client_id : null
  const firm = isFirmRole(user.role)
  const t = today()

  // ---- 各客户待处理漏斗 ----
  const clients = scoped
    ? await query('SELECT * FROM clients WHERE id = ?', [cid])
    : await query('SELECT * FROM clients ORDER BY id')
  const funnels = []
  for (const cl of clients) {
    const rows = await query('SELECT status, COUNT(*) AS n FROM cases WHERE client_id = ? GROUP BY status', [cl.id])
    const byStatus = {}
    for (const r of rows) byStatus[r.status] = Number(r.n)
    const active = rows.filter((r) => r.status !== '委托中').reduce((s, r) => s + Number(r.n), 0)
    const pend = await query(
      "SELECT COUNT(*) AS n FROM deadlines dl JOIN cases c ON c.id = dl.case_id WHERE c.client_id = ? AND dl.status = '待处理'",
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
      pending_deadlines: Number(pend[0].n),
      overdue_fees: Number(od[0].n),
    })
  }

  // ---- 官文期限（30 天内 + 已逾期，按到期日升序）----
  const scopeDl = scoped ? 'AND c.client_id = ?' : ''
  const dlParams = scoped ? [daysFromNow(30), cid] : [daysFromNow(30)]
  const dlRows = await query(
    `SELECT dl.id, dl.dtype, dl.due_date, dl.note, c.id AS case_id, c.case_no, c.title AS case_title, c.status AS case_status,
            cl.id AS client_id, cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code
     FROM deadlines dl JOIN cases c ON c.id = dl.case_id JOIN clients cl ON cl.id = c.client_id
     WHERE dl.status = '待处理' AND dl.due_date <= ? ${scopeDl}
     ORDER BY dl.due_date ASC LIMIT 50`,
    dlParams
  )
  const deadlines = dlRows.map((r) => ({
    id: r.id,
    dtype: r.dtype,
    due_date: r.due_date,
    d_day: daysBetween(t, r.due_date),
    overdue: r.due_date < t,
    note: r.note,
    case_id: r.case_id,
    case_no: r.case_no,
    case_title: r.case_title,
    client_name: firm && r.case_status !== '委托中' ? `${r.client_short_code}·${r.client_code}` : r.client_name,
  }))

  // ---- 缴费逾期（红点）----
  const feeParams = scoped ? [t, cid] : [t]
  const feeRows = await query(
    `SELECT f.id, f.kind, f.amount, f.due_date, c.id AS case_id, c.case_no, c.title AS case_title, c.status AS case_status,
            cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code
     FROM fees f JOIN cases c ON c.id = f.case_id JOIN clients cl ON cl.id = c.client_id
     WHERE f.status = '待缴' AND f.due_date < ? ${scopeDl}
     ORDER BY f.due_date ASC LIMIT 50`,
    feeParams
  )
  const overdueFees = feeRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amount: Number(r.amount),
    due_date: r.due_date,
    overdue_days: daysBetween(r.due_date, t),
    case_id: r.case_id,
    case_no: r.case_no,
    case_title: r.case_title,
    client_name: firm && r.case_status !== '委托中' ? `${r.client_short_code}·${r.client_code}` : r.client_name,
  }))

  // ---- KPI ----
  const kpiParams = scoped ? [cid] : []
  const kpiWhere = scoped ? 'WHERE client_id = ?' : ''
  const activeCases = await query(
    `SELECT COUNT(*) AS n FROM cases ${kpiWhere}${kpiWhere ? ' AND' : 'WHERE'} status IN ('委托中','已立项','实审中','复审中')`,
    kpiParams
  )
  const soon7 = deadlines.filter((d) => !d.overdue && d.d_day <= 7).length
  const overdueDl = deadlines.filter((d) => d.overdue).length

  return {
    generated_at: new Date().toISOString(),
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
  }
}
