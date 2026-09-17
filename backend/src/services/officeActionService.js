import { query, tx } from '../db.js'
import { ApiError } from '../middleware/error.js'
import { assertClientAccess } from '../middleware/auth.js'
import { checkTransition, isOaAllowedAtStage, edgeSpec } from '../lib/stateMachine.js'
import { OA_TYPES } from '../lib/oaCatalog.js'
import { computeDueDate, resolveReceiveDate } from '../lib/deadlines.js'
import { computeCompletion } from '../lib/completion.js'
import { isFirmRole } from '../lib/mask.js'
import { nowIso } from '../lib/dates.js'
import { getFirmContext, localToday } from './settingsService.js'
import { bumpDash } from './dashboardService.js'

async function loadCase(user, caseId) {
  const rows = await query('SELECT * FROM cases WHERE id = ?', [caseId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '案件不存在')
  assertClientAccess(user, rows[0].client_id)
  return rows[0]
}

function presentOa(r) {
  return {
    id: r.id,
    case_id: r.case_id,
    oa_type: r.oa_type,
    oa_type_label: OA_TYPES[r.oa_type]?.label || r.oa_type,
    doc_no: r.doc_no,
    title: r.title,
    dispatch_date: r.dispatch_date,
    receive_date: r.receive_date,
    presumed_days: r.presumed_days,
    receive_presumed: !!r.receive_presumed,
    effective_receive_date: r.receive_date || null,
    target_status: r.target_status,
    status: r.status,
    withdraw_reason: r.withdraw_reason,
    note: r.note,
    created_by_name: r.created_by_name,
    created_at: r.created_at,
    withdrawn_at: r.withdrawn_at,
    withdrawn_by_name: r.withdrawn_by_name,
  }
}

export async function listOfficeActions(user, caseId) {
  const c = await loadCase(user, caseId)
  const rows = await query('SELECT * FROM office_actions WHERE case_id = ? ORDER BY dispatch_date DESC, id DESC', [caseId])
  const dlRows = await query('SELECT * FROM deadlines WHERE case_id = ? AND voided = 0 ORDER BY due_date ASC, id ASC', [caseId])
  return {
    case_status: c.status,
    office_actions: rows.map((r) => ({
      ...presentOa(r),
      effective_receive_date: r.receive_date || resolveReceiveDate({ dispatch_date: r.dispatch_date, presumed_days: r.presumed_days }).receive_date,
      deadlines: dlRows.filter((d) => d.office_action_id === r.id).map(deadlinePresent),
    })),
    manual_deadlines: dlRows.filter((d) => !d.office_action_id).map(deadlinePresent),
  }
}

function deadlinePresent(d) {
  return {
    ...d,
    receive_presumed: !!d.receive_presumed,
    rolled_forward: !!d.rolled_forward,
    voided: !!d.voided,
  }
}

// 完成度（作战台 / 详情 / 导出共用）
export async function getCompletion(caseId, caseStatus) {
  const rows = await query('SELECT oa_type, status FROM office_actions WHERE case_id = ?', [caseId])
  return computeCompletion({ officeActions: rows, caseStatus })
}

function validateDeadlineSpec(item) {
  const out = {
    title: String(item.title || '').trim(),
    base_type: ['receive', 'dispatch'].includes(item.base_type) ? item.base_type : 'receive',
    window_value: Math.trunc(Number(item.window_value) || 0),
    window_unit: item.window_unit === 'month' ? 'month' : 'day',
    day_basis: ['natural', 'workday', 'legal'].includes(item.day_basis) ? item.day_basis : 'natural',
    due_date: item.due_date || null,
  }
  if (!out.title) throw new ApiError(400, 'BAD_REQUEST', '期限事项名称不能为空')
  if (out.due_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.due_date)) throw new ApiError(400, 'BAD_REQUEST', `期限「${out.title}」的指定到期日格式应为 YYYY-MM-DD`)
    out.base_type = 'manual'
  } else if (out.window_value <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', `期限「${out.title}」缺少期限长度（window_value）`)
  }
  return out
}

/**
 * 登记官文。官文是驱动案件流转的唯一事实入口：
 *   - 状态跃迁由官文目录给出，并经状态机统一校验（禁跳步、禁非法跃迁、角色前置）；
 *   - 派生期限由服务端期限引擎按登记口径统一推算（界面明示起算日/天数口径）；
 *   - payload.deadlines 给出时覆盖目录模板（登记时可改期限长度/口径），条目也可直接指定 due_date。
 */
export async function registerOfficeAction(user, caseId, payload = {}) {
  const c = await loadCase(user, caseId)
  const def = OA_TYPES[payload.oa_type]
  if (!def) throw new ApiError(400, 'BAD_REQUEST', `未知官文类型「${payload.oa_type}」`)
  const dispatchDate = payload.dispatch_date
  if (!dispatchDate || !/^\d{4}-\d{2}-\d{2}$/.test(dispatchDate)) {
    throw new ApiError(400, 'BAD_REQUEST', '请选择官文发文日（YYYY-MM-DD）')
  }
  let receiveDate = payload.receive_date || null
  if (receiveDate && !/^\d{4}-\d{2}-\d{2}$/.test(receiveDate)) {
    throw new ApiError(400, 'BAD_REQUEST', '实际收到日格式应为 YYYY-MM-DD')
  }
  if (receiveDate && receiveDate < dispatchDate) {
    throw new ApiError(400, 'BAD_REQUEST', `实际收到日（${receiveDate}）不能早于发文日（${dispatchDate}）；如属邮寄异常请在备注说明并核实`)
  }
  const presumedDays = Math.max(0, Math.trunc(Number(payload.presumed_days) || 15))
  const { receive_date: effReceive, presumed } = resolveReceiveDate({ dispatch_date: dispatchDate, receive_date: receiveDate, presumed_days: presumedDays })

  // 状态机校验：过程性官文（target=null）只校验所属程序阶段与角色；
  // 状态类官文先过状态机（跳步/非法回退/角色/前置），再核对官文类型与该边是否匹配（堵住跨程序混用）。
  const target = def.target
  let chk = null
  const finalAgent = payload.agent_id ?? c.agent_id
  const isAssignee = c.agent_id === user.id
  if (target) {
    const signed = await query("SELECT id FROM contracts WHERE client_id = ? AND status = '已签署'", [c.client_id])
    chk = checkTransition({
      from: c.status,
      to: target,
      role: user.role,
      isAssignee,
      hasContract: signed.length > 0,
      hasAgent: Boolean(finalAgent),
    })
    if (!chk.ok) throw new ApiError(chk.http, chk.code, chk.message)
    const edge = edgeSpec(c.status, target)
    if (edge && !edge.oa.includes(def.key)) {
      throw new ApiError(
        409,
        'ILLEGAL_OA',
        `官文「${def.label}」不能把案件从「${c.status}」驱动到「${target}」：该跃迁须凭 ${edge.oa.map((k) => `「${OA_TYPES[k]?.label || k}」`).join('或')}办理。同名结果在复审/无效程序中须使用对应程序的决定书，请勿跨程序混用。`
      )
    }
  } else if (!isOaAllowedAtStage(def.key, null, c.status, user.role, isAssignee)) {
    throw new ApiError(409, 'ILLEGAL_OA', `「${def.label}」属于特定程序阶段的过程性官文，当前案件处于「${c.status}」，不能在此阶段登记。`)
  }

  // 期限条目：调用方可覆盖模板；未提供时用目录模板
  const specs = Array.isArray(payload.deadlines) && payload.deadlines.length
    ? payload.deadlines.map(validateDeadlineSpec)
    : def.deadlines.map((d) => validateDeadlineSpec(d))

  const ctx = await getFirmContext()
  const now = nowIso()
  const oaId = await tx(async (d) => {
    const newId = await d.insert(
      `INSERT INTO office_actions
       (case_id, oa_type, doc_no, title, dispatch_date, receive_date, presumed_days, receive_presumed, target_status, status, note, created_by, created_by_name, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [caseId, def.key, payload.doc_no || '', payload.title || '', dispatchDate, receiveDate, presumedDays, presumed ? 1 : 0, target, 'active', payload.note || '', user.id, user.name, now]
    )
    for (const spec of specs) {
      let due
      let baseDate = null
      let rolled = 0
      let recvPresumed = 0
      if (spec.base_type === 'manual') {
        due = spec.due_date
      } else {
        const r = computeDueDate({
          dispatch_date: dispatchDate,
          receive_date: receiveDate,
          presumed_days: presumedDays,
          base_type: spec.base_type,
          window_value: spec.window_value,
          window_unit: spec.window_unit,
          day_basis: spec.day_basis,
          calendarOverride: ctx.calendarOverride,
        })
        due = r.due_date
        baseDate = r.base_date
        rolled = r.rolled_forward ? 1 : 0
        recvPresumed = r.receive_presumed ? 1 : 0
      }
      await d.insert(
        `INSERT INTO deadlines
         (case_id, dtype, due_date, status, note, completed_at, created_at, source, office_action_id,
          base_type, base_date, day_basis, window_value, window_unit, receive_presumed, rolled_forward)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [caseId, spec.title, due, '待处理', payload.note || '', null, now, 'office_action', newId,
         spec.base_type, baseDate, spec.day_basis, spec.base_type === 'manual' ? null : spec.window_value,
         spec.base_type === 'manual' ? null : spec.window_unit, recvPresumed, rolled]
      )
    }
    if (target && !chk?.noop) {
      await d.query('UPDATE cases SET status = ?, agent_id = ?, version = version + 1, updated_at = ? WHERE id = ?', [target, finalAgent, now, caseId])
      await d.insert(
        `INSERT INTO case_events (case_id, from_status, to_status, action, actor_id, actor_name, reason, event_source, ref_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [caseId, c.status, target, chk.label || def.label, user.id, user.name, payload.note || '', 'office_action', newId, now]
      )
    }
    return newId
  })
  await bumpDash()
  return { id: oaId, target_status: target, effective_receive_date: effReceive, receive_presumed: presumed, noop: chk?.noop || false }
}

/**
 * 撤回官文（登记错误/官文被撤回）：
 *   - 必须填写撤回原因并留痕；
 *   - 该官文派生的未完成期限一并作废（已完成的保留留痕，不删除）；
 *   - 案件状态恢复到「撤回后最近一条有效状态类官文」所支撑的状态；无则回到「申请」。
 */
export async function withdrawOfficeAction(user, oaId, { reason } = {}) {
  if (!reason || String(reason).trim().length < 2) {
    throw new ApiError(400, 'BAD_REQUEST', '撤回官文必须填写原因（至少 2 个字），本次撤回将留痕')
  }
  const rows = await query('SELECT * FROM office_actions WHERE id = ?', [oaId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '官文不存在')
  const oa = rows[0]
  const c = await loadCase(user, oa.case_id)
  if (oa.status === 'withdrawn') throw new ApiError(409, 'OA_WITHDRAWN', '该官文已撤回，请勿重复操作')

  const now = nowIso()
  let revertedTo = c.status
  await tx(async (d) => {
    await d.query(
      'UPDATE office_actions SET status = ?, withdraw_reason = ?, withdrawn_at = ?, withdrawn_by = ?, withdrawn_by_name = ? WHERE id = ?',
      ['withdrawn', String(reason).trim(), now, user.id, user.name, oaId]
    )
    // 派生期限：未完成的作废；已完成的保留（留痕）
    await d.query(
      "UPDATE deadlines SET voided = 1, voided_reason = ? WHERE office_action_id = ? AND voided = 0 AND status = '待处理'",
      [`随官文撤回作废：${String(reason).trim()}`, oaId]
    )
    if (oa.target_status) {
      // 重放有效官文链：按发文日、id 排序，最后一条状态类官文的目标即当前应有状态
      const chain = await d.query(
        "SELECT target_status FROM office_actions WHERE case_id = ? AND status = 'active' AND target_status IS NOT NULL ORDER BY dispatch_date ASC, id ASC",
        [oa.case_id]
      )
      revertedTo = chain.length ? chain[chain.length - 1].target_status : '申请'
      if (revertedTo !== c.status) {
        await d.query('UPDATE cases SET status = ?, version = version + 1, updated_at = ? WHERE id = ?', [revertedTo, now, c.id])
        await d.insert(
          `INSERT INTO case_events (case_id, from_status, to_status, action, actor_id, actor_name, reason, event_source, ref_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [c.id, c.status, revertedTo, `撤回官文（${OA_TYPES[oa.oa_type]?.label || oa.oa_type}）`, user.id, user.name, String(reason).trim(), 'withdraw', oaId, now]
        )
      }
    }
  })
  await bumpDash()
  return { id: oaId, status: 'withdrawn', reverted_to: revertedTo }
}

// 日历/作战台共用：带口径快照与「剩几天」的期限视图
export async function presentDeadline(d, { timezone, today } = {}) {
  const out = deadlinePresent(d)
  out.overdue = d.status === '待处理' && d.due_date < today
  out.d_day = Math.round((Date.parse(d.due_date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000)
  out.timezone = timezone
  out.base_type_label = d.base_type === 'receive' ? '自收到日起算' : d.base_type === 'dispatch' ? '自发文日起算' : d.base_type === 'manual' ? '指定到期日' : ''
  out.day_basis_label = d.day_basis === 'workday' ? '工作日' : d.day_basis === 'legal' ? '法定节假日口径' : d.day_basis === 'natural' ? '自然日' : ''
  return out
}

export async function firmToday() {
  const ctx = await getFirmContext()
  return { ctx, today: localToday(ctx.timezone) }
}

export { isFirmRole }
