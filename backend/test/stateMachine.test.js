import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkTransition, allowedTransitionsFor, STATUSES, isOaAllowedAtStage } from '../src/lib/stateMachine.js'

const base = { role: 'admin', isAssignee: false, hasContract: true, hasAgent: true }

test('八态集合完整', () => {
  assert.deepEqual(STATUSES, ['申请', '受理', '初审', '实审', '授权', '驳回', '复审', '无效'])
})

test('合法主干：申请→受理→初审→实审→授权', () => {
  assert.equal(checkTransition({ ...base, from: '申请', to: '受理' }).ok, true)
  assert.equal(checkTransition({ ...base, from: '受理', to: '初审' }).ok, true)
  assert.equal(checkTransition({ ...base, from: '初审', to: '实审' }).ok, true)
  assert.equal(checkTransition({ ...base, from: '实审', to: '授权' }).ok, true)
})

test('驳回进复审为合法「回退/复活」，复审又可回实审/授权/驳回（状态允许来回）', () => {
  assert.equal(checkTransition({ ...base, from: '实审', to: '驳回' }).ok, true)
  assert.equal(checkTransition({ ...base, role: 'agent', isAssignee: true, from: '驳回', to: '复审' }).ok, true)
  assert.equal(checkTransition({ ...base, role: 'reviewer', from: '复审', to: '实审' }).ok, true)
  assert.equal(checkTransition({ ...base, role: 'reviewer', from: '复审', to: '授权' }).ok, true)
  assert.equal(checkTransition({ ...base, role: 'reviewer', from: '复审', to: '驳回' }).ok, true)
})

test('无效程序来回：授权→无效→授权（维持有效）/驳回（宣告无效）', () => {
  assert.equal(checkTransition({ ...base, from: '授权', to: '无效' }).ok, true)
  assert.equal(checkTransition({ ...base, from: '无效', to: '授权' }).ok, true)
  assert.equal(checkTransition({ ...base, from: '无效', to: '驳回' }).ok, true)
})

test('禁跳步：申请直接到实审/授权均拦截并提示下一步', () => {
  const skip = checkTransition({ ...base, from: '申请', to: '实审' })
  assert.equal(skip.ok, false)
  assert.equal(skip.code, 'ILLEGAL_TRANSITION')
  assert.match(skip.message, /受理/)
  assert.equal(checkTransition({ ...base, from: '受理', to: '实审' }).code, 'ILLEGAL_TRANSITION')
})

test('非法跃迁（无官文支撑的回退）：实审→受理 拦截', () => {
  const r = checkTransition({ ...base, from: '实审', to: '受理' })
  assert.equal(r.ok, false)
  assert.equal(r.http, 409)
  assert.equal(r.code, 'ILLEGAL_ROLLBACK')
  assert.match(r.message, /不能直接回退/)
})

test('驳回不能直接回实审（必须经复审），授权不能直接回实审', () => {
  assert.equal(checkTransition({ ...base, from: '驳回', to: '实审' }).code, 'ILLEGAL_ROLLBACK')
  assert.equal(checkTransition({ ...base, from: '授权', to: '实审' }).code, 'ILLEGAL_ROLLBACK')
})

test('同状态为幂等空操作', () => {
  const r = checkTransition({ ...base, from: '实审', to: '实审' })
  assert.equal(r.ok, true)
  assert.equal(r.noop, true)
})

test('受理前置条件：未签合同 / 未派代理人', () => {
  const noContract = checkTransition({ ...base, from: '申请', to: '受理', hasContract: false })
  assert.equal(noContract.code, 'NO_CONTRACT')
  const noAgent = checkTransition({ ...base, from: '申请', to: '受理', hasAgent: false })
  assert.equal(noAgent.code, 'NO_AGENT')
})

test('角色权限：代理人不能登记授权/驳回决定，审核员可以', () => {
  const agent = checkTransition({ ...base, role: 'agent', isAssignee: true, from: '实审', to: '授权' })
  assert.equal(agent.ok, false)
  assert.equal(agent.http, 403)
  assert.equal(agent.code, 'ROLE_DENIED')
  assert.equal(checkTransition({ ...base, role: 'reviewer', from: '实审', to: '驳回' }).ok, true)
})

test('代理人只能操作名下案件', () => {
  const r = checkTransition({ ...base, role: 'agent', isAssignee: false, from: '初审', to: '实审' })
  assert.equal(r.code, 'NOT_ASSIGNEE')
})

test('客户管理员无任何流转权限', () => {
  const r = checkTransition({ ...base, role: 'client_admin', from: '受理', to: '初审' })
  assert.equal(r.code, 'ROLE_DENIED')
})

test('allowedTransitionsFor 按角色与状态过滤', () => {
  assert.deepEqual(allowedTransitionsFor('实审', 'admin', false).map((t) => t.to).sort(), ['授权', '驳回'])
  assert.deepEqual(allowedTransitionsFor('实审', 'agent', true), [])
  assert.deepEqual(allowedTransitionsFor('驳回', 'agent', true).map((t) => t.to), ['复审'])
  assert.deepEqual(allowedTransitionsFor('申请', 'agent', true), [])
})

test('官文-程序匹配：同名结果不同程序不可混用（堵住绕程序跃迁）', () => {
  // 复审改判授权只能在复审阶段登记，不能在实审直接用
  assert.equal(isOaAllowedAtStage('reexamination_grant', '授权', '实审', 'admin', false), false)
  assert.equal(isOaAllowedAtStage('reexamination_grant', '授权', '复审', 'admin', false), true)
  // 无效宣告决定只能在无效阶段登记
  assert.equal(isOaAllowedAtStage('invalidation_void', '驳回', '实审', 'admin', false), false)
  assert.equal(isOaAllowedAtStage('invalidation_void', '驳回', '驳回', 'admin', false), false)
  assert.equal(isOaAllowedAtStage('invalidation_void', '驳回', '无效', 'admin', false), true)
  // 正常授权办登只在实审
  assert.equal(isOaAllowedAtStage('grant_notice', '授权', '复审', 'admin', false), false)
  assert.equal(isOaAllowedAtStage('grant_notice', '授权', '实审', 'reviewer', false), true)
})

test('过程性官文只属于其程序阶段；other 不限；代理人受名下限制', () => {
  assert.equal(isOaAllowedAtStage('examination_opinion', null, '实审', 'admin', false), true)
  assert.equal(isOaAllowedAtStage('examination_opinion', null, '复审', 'admin', false), false)
  assert.equal(isOaAllowedAtStage('reexamination_opinion', null, '实审', 'admin', false), false)
  assert.equal(isOaAllowedAtStage('reexamination_opinion', null, '复审', 'admin', false), true)
  assert.equal(isOaAllowedAtStage('other', null, '受理', 'admin', false), true)
  assert.equal(isOaAllowedAtStage('examination_opinion', null, '实审', 'agent', false), false)
  assert.equal(isOaAllowedAtStage('examination_opinion', null, '实审', 'agent', true), true)
  assert.equal(isOaAllowedAtStage('other', null, '实审', 'client_admin', false), false)
})
