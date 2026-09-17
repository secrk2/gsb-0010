import { Router } from 'express'
import { query } from '../db.js'
import { asyncH } from '../middleware/error.js'
import { requireRole } from '../middleware/auth.js'
import { completeDeadline, payFee } from '../services/workflowService.js'

const router = Router()

// 期限完成（逾期需 body.confirmed + body.reason，二次确认留痕）/ 费用缴纳（幂等）
router.post(
  '/deadlines/:id/complete',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    res.json({ data: await completeDeadline(req.user, Number(req.params.id), req.body || {}) })
  })
)

router.post(
  '/fees/:id/pay',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    res.json({ data: await payFee(req.user, Number(req.params.id)) })
  })
)

// 代理人名单（受理派案下拉用）
router.get(
  '/agents',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    const rows = await query("SELECT id, name FROM users WHERE role = 'agent' ORDER BY id")
    res.json({ data: rows })
  })
)

export default router
