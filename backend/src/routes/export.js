import { Router } from 'express'
import { asyncH } from '../middleware/error.js'
import { buildCasesCsv, CSV_BOM } from '../services/exportService.js'

const router = Router()

// 案件完成度导出（CSV）。完成度两口径各自成列，与作战台/案件详情同一计算来源。
router.get(
  '/cases.csv',
  asyncH(async (req, res) => {
    const csv = await buildCasesCsv(req.user)
    const stamp = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''cases-completion-${stamp}.csv`)
    res.send(CSV_BOM + csv)
  })
)

export default router
