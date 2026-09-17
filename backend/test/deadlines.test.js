import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeDueDate, presumedReceiveDate, resolveReceiveDate, addCalendarMonths, remainingDays,
} from '../src/lib/deadlines.js'

test('推定收到日 = 发文日 + 15 自然日', () => {
  assert.equal(presumedReceiveDate('2026-02-10'), '2026-02-25')
  const r = resolveReceiveDate({ dispatch_date: '2026-02-10' })
  assert.deepEqual(r, { receive_date: '2026-02-25', presumed: true })
  const real = resolveReceiveDate({ dispatch_date: '2026-02-10', receive_date: '2026-02-13' })
  assert.deepEqual(real, { receive_date: '2026-02-13', presumed: false })
})

test('自收到日 vs 自发文日：发文日与收到日差数日，到期日不同，界面可明示', () => {
  const recv = computeDueDate({ dispatch_date: '2026-03-01', base_type: 'receive', window_value: 30, day_basis: 'natural' })
  const disp = computeDueDate({ dispatch_date: '2026-03-01', base_type: 'dispatch', window_value: 30, day_basis: 'natural' })
  assert.equal(recv.base_date, '2026-03-16') // 推定收到
  assert.equal(disp.base_date, '2026-03-01') // 发文
  assert.equal(recv.due_date, '2026-04-15')
  assert.equal(disp.due_date, '2026-03-31')
})

test('春节长假：自然日/工作日/法定 三口径结果不同', () => {
  // 推定收到日 2026-02-25（春节假期 2/16-2/22 刚过）
  const spec = { dispatch_date: '2026-02-10', base_type: 'receive', window_value: 10 }
  const natural = computeDueDate({ ...spec, day_basis: 'natural' })
  const workday = computeDueDate({ ...spec, day_basis: 'workday' })
  const legal = computeDueDate({ ...spec, day_basis: 'legal' })
  // 02-25 + 10 自然日 = 03-07（周六）→ 法定顺延至 03-09（周一）
  assert.equal(natural.due_date, '2026-03-09')
  assert.equal(natural.rolled_forward, true)
  // 工作日：跳周末但不剔春节（此时春节已过，只剩周末）→ 03-11（周三）
  assert.equal(workday.due_date, '2026-03-11')
  // 法定：起算后区间内无春节（02-25 之后），但 2/28 为调休上班日（周六）计入 → 03-10（周二）
  assert.equal(legal.due_date, '2026-03-10')
})

test('法定口径：春节假期内起算，休假日与周末不计入，调休上班日计入', () => {
  // 收到日 2026-02-13（周五，春节假前最后一个工作日）
  // 20 个法定工作日：2/16-22 春节休、2/14-15 周末休、2/28(六)调休上班
  const legal = computeDueDate({ dispatch_date: '2026-02-13', receive_date: '2026-02-13', base_type: 'receive', window_value: 20, day_basis: 'legal' })
  const workday = computeDueDate({ dispatch_date: '2026-02-13', receive_date: '2026-02-13', base_type: 'receive', window_value: 20, day_basis: 'workday' })
  // 法定口径剔除春节 5 个工作日，虽有 2/28 调休补回 1 天，仍晚于纯工作日口径
  assert.ok(legal.due_date > workday.due_date, `${legal.due_date} 应晚于 ${workday.due_date}`)
  assert.equal(legal.due_date, '2026-03-18')
  assert.equal(workday.due_date, '2026-03-13')
})

test('到期日撞国庆法定假日 → 顺延至假后第一个工作日（10-08）', () => {
  const r = computeDueDate({ dispatch_date: '2026-09-25', receive_date: '2026-09-25', base_type: 'receive', window_value: 6, day_basis: 'natural' })
  assert.equal(r.due_date, '2026-10-08')
  assert.equal(r.rolled_forward, true)
})

test('调休上班日（2026-05-09 周六补班）法定口径计入', () => {
  const r = computeDueDate({ dispatch_date: '2026-05-08', receive_date: '2026-05-08', base_type: 'receive', window_value: 1, day_basis: 'legal' })
  assert.equal(r.due_date, '2026-05-09')
})

test('按月期限：对应日；月末取该月最后一天；到期为假日依法顺延', () => {
  assert.equal(addCalendarMonths('2026-01-31', 1), '2026-02-28')
  const m3 = computeDueDate({ dispatch_date: '2026-01-31', base_type: 'dispatch', window_value: 3, window_unit: 'month' })
  // 1/31 +3 月 = 4/30（周四）
  assert.equal(m3.due_date, '2026-04-30')
})

test('库表节假日覆盖：自定义补假可改变法定口径结果', () => {
  // 将 2026-03-10（周二）设为额外休假日，法定口径 10 个工作日应顺延一天
  const base = { dispatch_date: '2026-02-25', receive_date: '2026-02-25', base_type: 'receive', window_value: 10, day_basis: 'legal' }
  const normal = computeDueDate(base)
  const custom = computeDueDate({ ...base, calendarOverride: { holidays: ['2026-03-10'] } })
  assert.ok(custom.due_date > normal.due_date)
})

test('剩余天数：UTC 日期串计算，逾期为负', () => {
  assert.deepEqual(remainingDays('2026-09-20', '2026-09-17').days, 3)
  assert.equal(remainingDays('2026-09-10', '2026-09-17').overdue, true)
  assert.equal(remainingDays('2026-09-10', '2026-09-17').days, -7)
})
