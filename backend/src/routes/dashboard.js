import { Router } from 'express'
import { asyncH } from '../middleware/error.js'
import { getDashboard } from '../services/dashboardService.js'

const router = Router()

router.get(
  '/',
  asyncH(async (req, res) => {
    res.json({ data: await getDashboard(req.user) })
  })
)

export default router
