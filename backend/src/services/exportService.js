import { query } from '../db.js'
import { isFirmRole } from '../lib/mask.js'
import { getCompletion } from './officeActionService.js'
import { getFirmContext, localToday } from './settingsService.js'

// CSV 导出：完成度两口径同时列出（列名写清口径），与作战台/详情数字同源。
export async function buildCasesCsv(user) {
  const scoped = user.role === 'client_admin'
  const args = scoped ? [user.client_id] : []
  const rows = await query(
    `SELECT c.*, cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code, u.name AS agent_name
     FROM cases c
     JOIN clients cl ON cl.id = c.client_id
     LEFT JOIN users u ON u.id = c.agent_id
     ${scoped ? 'WHERE c.client_id = ?' : ''}
     ORDER BY c.id`,
    args
  )
  const firm = isFirmRole(user.role)
  const ctx = await getFirmContext()
  const today = localToday(ctx.timezone)
  const header = [
    '案件号', '案件名称', '客户', '类型', '当前状态', '代理人', '优先级',
    '完成度-已归档官文数口径(%)', '已归档官文数', '必经主线官文数',
    '完成度-关键阶段数口径(%)', '已完成关键阶段数', '关键阶段总数',
    '待处理期限数', '已逾期期限数', '最近期限到期日', '导出时区',
  ]
  const lines = [header]
  for (const r of rows) {
    const comp = await getCompletion(r.id, r.status)
    const dls = await query('SELECT due_date, status FROM deadlines WHERE case_id = ? AND voided = 0', [r.id])
    const pending = dls.filter((d) => d.status === '待处理')
    const overdue = pending.filter((d) => d.due_date < today)
    const nextDue = pending.map((d) => d.due_date).sort()[0] || ''
    const clientName = firm && r.status !== '申请' ? `${r.client_short_code}·${r.client_code}` : r.client_name
    lines.push([
      r.case_no, r.title, clientName, r.ctype, r.status, r.agent_name || '待指派', r.priority,
      comp.documents.percent, comp.documents.done, comp.documents.total,
      comp.stages.percent, comp.stages.done, comp.stages.total,
      pending.length, overdue.length, nextDue, ctx.timezone,
    ])
  }
  return toCsv(lines)
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
}

function csvCell(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// UTF-8 BOM 让 Excel 正确识别中文
export const CSV_BOM = '﻿'
