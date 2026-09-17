import { Router } from 'express'
import { redis } from '../redis.js'
import { asyncH } from '../middleware/error.js'
import { requireRole } from '../middleware/auth.js'
import { createCase, transitionCase } from '../services/caseService.js'
import { completeDeadline, payFee, addDeadline } from '../services/workflowService.js'
import { registerOfficeAction, withdrawOfficeAction } from '../services/officeActionService.js'

const router = Router()

// 离线变更合并入口：前端恢复网络后，把离线期间排队的操作一次性提交。
// 每条操作带客户端生成的幂等 key：
//   - 同 key 重放 → 返回首次结果（duplicate）
//   - case.create 另有 client_uuid 唯一约束兜底，绝不产生重复案件
//   - case.transition / oa.register 按服务器当前状态重新校验：仍合法则执行（合并），
//     目标状态已达成则视为重复，非法跃迁则标记 conflict 并带回服务器现状
router.post(
  '/batch',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    const ops = Array.isArray(req.body?.ops) ? req.body.ops.slice(0, 100) : []
    const results = []
    for (const op of ops) {
      results.push(await applyOp(req.user, op))
    }
    res.json({ data: { results } })
  })
)

const CONFLICT_CODES = ['ILLEGAL_ROLLBACK', 'ILLEGAL_TRANSITION', 'NOT_ASSIGNEE', 'ROLE_DENIED', 'NO_CONTRACT', 'NO_AGENT', 'ILLEGAL_OA']

async function applyOp(user, op) {
  const { key, op: type, payload = {} } = op || {}
  if (!key || !type) return { key: key || null, status: 'error', code: 'BAD_OP', message: '操作缺少 key 或 op 类型' }
  const cacheKey = `sync:${key}`
  try {
    const hit = await redis().get(cacheKey)
    if (hit) return { key, status: 'duplicate', result: JSON.parse(hit) }
  } catch {}
  let out
  try {
    switch (type) {
      case 'case.create': {
        const r = await createCase(user, payload)
        out = { status: r.deduped ? 'duplicate' : 'applied', data: { case_id: r.case.id, case_no: r.case.case_no } }
        break
      }
      case 'case.transition': {
        out = await syncTransition(user, payload)
        break
      }
      case 'oa.register': {
        out = await syncOaRegister(user, payload)
        break
      }
      case 'oa.withdraw': {
        // 撤回需要原因；重复撤回视为 duplicate
        try {
          const r = await withdrawOfficeAction(user, Number(payload.id), { reason: payload.reason })
          out = { status: 'applied', data: r }
        } catch (e) {
          if (e.code === 'OA_WITHDRAWN') out = { status: 'duplicate', data: { id: Number(payload.id) } }
          else throw e
        }
        break
      }
      case 'deadline.create': {
        const r = await addDeadline(user, Number(payload.case_id), payload)
        out = { status: 'applied', data: r }
        break
      }
      case 'deadline.complete': {
        await completeDeadline(user, Number(payload.id), { confirmed: true, reason: payload.reason || '离线期间办结（同步补录）' })
        out = { status: 'applied', data: { id: Number(payload.id) } }
        break
      }
      case 'fee.pay': {
        await payFee(user, Number(payload.id))
        out = { status: 'applied', data: { id: Number(payload.id) } }
        break
      }
      default:
        out = { status: 'error', code: 'UNKNOWN_OP', message: `未知操作类型：${type}` }
    }
  } catch (e) {
    if (CONFLICT_CODES.includes(e.code)) {
      out = { status: 'conflict', code: e.code, message: e.message }
    } else {
      out = { status: 'error', code: e.code || 'INTERNAL', message: e.message || '处理失败' }
    }
  }
  try {
    await redis().set(cacheKey, JSON.stringify(out), 'EX', 72 * 3600)
  } catch {}
  return { key, ...out }
}

async function syncTransition(user, payload) {
  const { case_id, to, reason = '', agent_id = null } = payload
  try {
    const r = await transitionCase(user, Number(case_id), { to, reason, agent_id })
    return { status: r.noop ? 'duplicate' : 'applied', data: { case_id: Number(case_id), status: r.case.status } }
  } catch (e) {
    if (CONFLICT_CODES.includes(e.code)) {
      return { status: 'conflict', code: e.code, message: e.message }
    }
    throw e
  }
}

async function syncOaRegister(user, payload) {
  const { case_id, ...rest } = payload
  try {
    const r = await registerOfficeAction(user, Number(case_id), rest)
    if (r.noop) return { status: 'duplicate', data: { case_id: Number(case_id), target_status: r.target_status } }
    return { status: 'applied', data: { office_action_id: r.id, target_status: r.target_status } }
  } catch (e) {
    if (CONFLICT_CODES.includes(e.code)) return { status: 'conflict', code: e.code, message: e.message }
    throw e
  }
}

export default router
