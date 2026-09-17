import { query } from '../db.js'
import { isFirmRole } from '../lib/mask.js'
import { getFirmContext, localToday } from './settingsService.js'
import { presentDeadline } from './officeActionService.js'

// 日历数据：返回区间内期限（含官文派生与手工）+ 区间内官文落点，由前端组装月/周视图。
// 日期一律 UTC 日期串；区间边界与「今天」均以代理所时区计算。
export async function getCalendar(user, { from, to, caseId, includeCompleted = '0' } = {}) {
  const ctx = await getFirmContext()
  const today = localToday(ctx.timezone)
  from = from || today
  to = to || today
  if (from > to) [from, to] = [to, from]

  const conds = ['dl.voided = 0']
  const params = []
  if (user.role === 'client_admin') {
    conds.push('c.client_id = ?')
    params.push(user.client_id)
  }
  if (caseId) {
    conds.push('dl.case_id = ?')
    params.push(Number(caseId))
  }
  conds.push('dl.due_date >= ?', 'dl.due_date <= ?')
  params.push(from, to)
  if (includeCompleted !== '1') conds.push("dl.status = '待处理'")

  const rows = await query(
    `SELECT dl.*, c.case_no, c.title AS case_title, c.status AS case_status,
            cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code
     FROM deadlines dl
     JOIN cases c ON c.id = dl.case_id
     JOIN clients cl ON cl.id = c.client_id
     WHERE ${conds.join(' AND ')}
     ORDER BY dl.due_date ASC, c.id ASC LIMIT 500`,
    params
  )
  const firm = isFirmRole(user.role)
  const deadlines = []
  for (const r of rows) {
    const d = await presentDeadline(r, { timezone: ctx.timezone, today })
    d.case_id = r.case_id
    d.case_no = r.case_no
    d.case_title = r.case_title
    d.case_status = r.case_status
    d.client_name = firm && r.case_status !== '申请' ? `${r.client_short_code}·${r.client_code}` : r.client_name
    deadlines.push(d)
  }

  // 官文落点（发文日/推定收到日均可在日历标记）
  const oaConds = ["oa.status = 'active'"]
  const oaParams = []
  if (user.role === 'client_admin') {
    oaConds.push('c.client_id = ?')
    oaParams.push(user.client_id)
  }
  if (caseId) {
    oaConds.push('oa.case_id = ?')
    oaParams.push(Number(caseId))
  }
  oaConds.push('oa.dispatch_date >= ?', 'oa.dispatch_date <= ?')
  oaParams.push(from, to)
  const oaRows = await query(
    `SELECT oa.id, oa.oa_type, oa.dispatch_date, oa.receive_date, oa.presumed_days, oa.target_status,
            c.id AS case_id, c.case_no, c.title AS case_title, c.status AS case_status,
            cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code
     FROM office_actions oa
     JOIN cases c ON c.id = oa.case_id
     JOIN clients cl ON cl.id = c.client_id
     WHERE ${oaConds.join(' AND ')}
     ORDER BY oa.dispatch_date ASC, c.id ASC LIMIT 500`,
    oaParams
  )
  const OA_LABELS = {
    receipt: '受理通知书', preliminary_pass: '初审合格/公布', enter_examination: '进入实审',
    examination_opinion: '审查意见', grant_notice: '授权办登', rejection: '驳回决定',
    reexamination_accept: '复审受理', reexamination_opinion: '复审意见', reexamination_revoke: '复审撤销驳回',
    reexamination_grant: '复审改判授权', reexamination_reject: '复审维持驳回',
    invalidation_accept: '无效受理', invalidation_valid: '无效维持有效', invalidation_void: '无效宣告',
    other: '其他官文',
  }
  const officeActions = oaRows.map((r) => ({
    id: r.id,
    oa_type: r.oa_type,
    oa_type_label: OA_LABELS[r.oa_type] || r.oa_type,
    dispatch_date: r.dispatch_date,
    receive_date: r.receive_date,
    target_status: r.target_status,
    case_id: r.case_id,
    case_no: r.case_no,
    case_title: r.case_title,
    case_status: r.case_status,
    client_name: firm && r.case_status !== '申请' ? `${r.client_short_code}·${r.client_code}` : r.client_name,
  }))

  return { timezone: ctx.timezone, today, from, to, deadlines, office_actions: officeActions }
}
