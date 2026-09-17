import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeCompletion, BACKBONE_TOTAL, STAGE_TOTAL } from '../src/lib/completion.js'

const oa = (oa_type, status = 'active') => ({ oa_type, status })

test('空申请：两口径都为 0', () => {
  const r = computeCompletion({ officeActions: [], caseStatus: '申请' })
  assert.equal(r.documents.percent, 0)
  assert.equal(r.stages.percent, 0)
  assert.equal(r.documents.total, BACKBONE_TOTAL)
  assert.equal(r.stages.total, STAGE_TOTAL)
})

test('受理+初审+实审：阶段口径 60%（3/5），官文口径 75%（3/4）', () => {
  const r = computeCompletion({
    officeActions: [oa('receipt'), oa('preliminary_pass'), oa('enter_examination')],
    caseStatus: '实审',
  })
  assert.equal(r.stages.done, 3)
  assert.equal(r.stages.percent, 60)
  assert.equal(r.documents.done, 3)
  assert.equal(r.documents.percent, 75)
})

test('半截官文：多通实审意见但案件仍在实审——官文口径显满、阶段口径不变（两口径相反）', () => {
  const r = computeCompletion({
    officeActions: [oa('receipt'), oa('preliminary_pass'), oa('enter_examination'), oa('examination_opinion'), oa('examination_opinion'), oa('examination_opinion')],
    caseStatus: '实审',
  })
  // 6 件已归档 / 4 主线 → 封顶 100%
  assert.equal(r.documents.done, 6)
  assert.equal(r.documents.percent, 100)
  assert.equal(r.documents.capped, true)
  // 阶段口径不被意见通次抬高：仍 3/5
  assert.equal(r.stages.done, 3)
  assert.equal(r.stages.percent, 60)
})

test('授权且无在办无效：阶段口径 100%（5/5）', () => {
  const r = computeCompletion({
    officeActions: [oa('receipt'), oa('preliminary_pass'), oa('enter_examination'), oa('grant_notice')],
    caseStatus: '授权',
  })
  assert.equal(r.stages.done, 5)
  assert.equal(r.stages.percent, 100)
  assert.equal(r.stages.finalized, true)
})

test('驳回但未提复审：有结论未终结，阶段口径 80%（4/5）', () => {
  const r = computeCompletion({
    officeActions: [oa('receipt'), oa('preliminary_pass'), oa('enter_examination'), oa('rejection')],
    caseStatus: '驳回',
  })
  assert.equal(r.stages.done, 4)
  assert.equal(r.stages.finalized, false)
})

test('复审维持驳回（复审受理后再驳回）：程序终结 100%', () => {
  const r = computeCompletion({
    officeActions: [oa('receipt'), oa('preliminary_pass'), oa('enter_examination'), oa('rejection'), oa('reexamination_accept'), oa('reexamination_reject')],
    caseStatus: '驳回',
  })
  assert.equal(r.stages.done, 5)
  assert.equal(r.stages.finalized, true)
})

test('授权后被提无效在办：授权不再算终结，阶段口径 80%', () => {
  const r = computeCompletion({
    officeActions: [oa('receipt'), oa('preliminary_pass'), oa('enter_examination'), oa('grant_notice'), oa('invalidation_accept')],
    caseStatus: '无效',
  })
  assert.equal(r.stages.done, 4)
  assert.equal(r.stages.finalized, false)
})

test('撤回的官文不计入任何口径；全部撤回时回到申请态 0%', () => {
  const r = computeCompletion({
    officeActions: [oa('receipt', 'withdrawn')],
    caseStatus: '申请',
  })
  assert.equal(r.documents.done, 0)
  assert.equal(r.stages.done, 0)
})
