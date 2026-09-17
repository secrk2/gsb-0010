import { Router } from 'express'
import { asyncH } from '../middleware/error.js'
import { requireRole } from '../middleware/auth.js'
import { listCases, getCaseDetail, createCase, transitionCase } from '../services/caseService.js'
import { addDeadline, addFee } from '../services/workflowService.js'
import { registerOfficeAction, withdrawOfficeAction, listOfficeActions } from '../services/officeActionService.js'

const router = Router()

router.get(
  '/',
  asyncH(async (req, res) => {
    const { status, client_id, mine } = req.query
    res.json({ data: await listCases(req.user, { status, client_id, mine: mine === '1' }) })
  })
)

// 创建委托案件（所内角色）。客户端必须携带 client_uuid 作为幂等键。
router.post(
  '/',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    const result = await createCase(req.user, req.body)
    res.status(result.deduped ? 200 : 201).json({ data: result })
  })
)

router.get(
  '/:id',
  asyncH(async (req, res) => {
    res.json({ data: await getCaseDetail(req.user, Number(req.params.id)) })
  })
)

// 官文列表（含派生/手工期限、撤回状态）
router.get(
  '/:id/office-actions',
  asyncH(async (req, res) => {
    res.json({ data: await listOfficeActions(req.user, Number(req.params.id)) })
  })
)

// 登记官文：驱动状态流转 + 派生法定期限（状态机统一校验，期限引擎统一推算）
router.post(
  '/:id/office-actions',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    res.status(201).json({ data: await registerOfficeAction(req.user, Number(req.params.id), req.body) })
  })
)

// 撤回官文（原因必填、留痕；派生未完成期限作废，状态恢复到有效官文链）
router.post(
  '/:id/office-actions/:oaId/withdraw',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    res.json({ data: await withdrawOfficeAction(req.user, Number(req.params.oaId), req.body || {}) })
  })
)

// 手动状态流转（异常更正入口，仍受状态机白名单约束；正常流程一律走官文登记）
router.post(
  '/:id/transition',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    res.json({ data: await transitionCase(req.user, Number(req.params.id), req.body) })
  })
)

router.post(
  '/:id/deadlines',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    res.status(201).json({ data: await addDeadline(req.user, Number(req.params.id), req.body) })
  })
)

router.post(
  '/:id/fees',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    res.status(201).json({ data: await addFee(req.user, Number(req.params.id), req.body) })
  })
)

export default router
