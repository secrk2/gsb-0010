import { Router } from 'express'
import { asyncH } from '../middleware/error.js'
import { getCalendar } from '../services/calendarService.js'

const router = Router()

// 月/周日历数据：from/to 为代理所时区下的 YYYY-MM-DD；可选 case_id 只看该案
router.get(
  '/',
  asyncH(async (req, res) => {
    const { from, to, case_id, completed } = req.query
    res.json({ data: await getCalendar(req.user, { from, to, caseId: case_id, includeCompleted: completed }) })
  })
)

export default router
