import { Router } from 'express'
import { asyncH } from '../middleware/error.js'
import { requireRole } from '../middleware/auth.js'
import { getSettings, updateSettings } from '../services/settingsService.js'

const router = Router()

// 所级设置（代理所时区等）；所有登录用户可读，前端据此把 UTC 日期显示为当地时间
router.get(
  '/',
  asyncH(async (_req, res) => {
    res.json({ data: await getSettings() })
  })
)

router.put(
  '/',
  requireRole('admin'),
  asyncH(async (req, res) => {
    res.json({ data: await updateSettings(req.user, req.body || {}) })
  })
)

export default router
