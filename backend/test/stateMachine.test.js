import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkTransition, allowedTransitionsFor } from '../src/lib/stateMachine.js'

const base = { role: 'admin', isAssignee: false, hasContract: true, hasAgent: true }

test('合法流转：委托中 → 已立项 → 实审中 → 授权', () => {
  assert.equal(checkTransition({ ...base, from: '委托中', to: '已立项' }).ok, true)
  assert.equal(checkTransition({ ...base, from: '已立项', to: '实审中' }).ok, true)
  assert.equal(checkTransition({ ...base, from: '实审中', to: '授权' }).ok, true)
})

test('非法回退被拦截且说明原因', () => {
  const r = checkTransition({ ...base, from: '实审中', to: '已立项' })
  assert.equal(r.ok, false)
  assert.equal(r.http, 409)
  assert.equal(r.code, 'ILLEGAL_ROLLBACK')
  assert.match(r.message, /非法回退/)
  assert.match(r.message, /实审中/)
  assert.match(r.message, /已立项/)
})

test('终态不可回退：授权 → 实审中', () => {
  const r = checkTransition({ ...base, from: '授权', to: '实审中' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'ILLEGAL_ROLLBACK')
})

test('跳级被拦截并提示下一步', () => {
  const r = checkTransition({ ...base, from: '委托中', to: '实审中' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'ILLEGAL_TRANSITION')
  assert.match(r.message, /已立项/)
})

test('同状态为幂等空操作', () => {
  const r = checkTransition({ ...base, from: '实审中', to: '实审中' })
  assert.equal(r.ok, true)
  assert.equal(r.noop, true)
})

test('立项前置条件：未签合同 / 未派代理人', () => {
  const noContract = checkTransition({ ...base, from: '委托中', to: '已立项', hasContract: false })
  assert.equal(noContract.code, 'NO_CONTRACT')
  assert.match(noContract.message, /委托合同/)
  const noAgent = checkTransition({ ...base, from: '委托中', to: '已立项', hasAgent: false })
  assert.equal(noAgent.code, 'NO_AGENT')
})

test('角色权限：代理人不能登记授权，审核员可以', () => {
  const agent = checkTransition({ ...base, role: 'agent', isAssignee: true, from: '实审中', to: '授权' })
  assert.equal(agent.ok, false)
  assert.equal(agent.http, 403)
  assert.equal(agent.code, 'ROLE_DENIED')
  assert.equal(checkTransition({ ...base, role: 'reviewer', from: '实审中', to: '授权' }).ok, true)
})

test('代理人只能操作名下案件', () => {
  const r = checkTransition({ ...base, role: 'agent', isAssignee: false, from: '已立项', to: '实审中' })
  assert.equal(r.code, 'NOT_ASSIGNEE')
})

test('客户管理员无任何流转权限', () => {
  const r = checkTransition({ ...base, role: 'client_admin', from: '已立项', to: '实审中' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'ROLE_DENIED')
})

test('复审链路：驳回 → 复审中 → 授权/维持驳回', () => {
  assert.equal(checkTransition({ ...base, role: 'agent', isAssignee: true, from: '驳回', to: '复审中' }).ok, true)
  assert.equal(checkTransition({ ...base, role: 'reviewer', from: '复审中', to: '授权' }).ok, true)
  assert.equal(checkTransition({ ...base, role: 'reviewer', from: '复审中', to: '驳回' }).ok, true)
  assert.equal(checkTransition({ ...base, from: '复审中', to: '实审中' }).code, 'ILLEGAL_ROLLBACK')
})

test('allowedTransitionsFor 按角色过滤', () => {
  const adminTargets = allowedTransitionsFor('实审中', 'admin', false).map((t) => t.to)
  assert.deepEqual(adminTargets.sort(), ['授权', '驳回'])
  const agentTargets = allowedTransitionsFor('实审中', 'agent', true)
  assert.deepEqual(agentTargets, [])
  assert.deepEqual(allowedTransitionsFor('授权', 'admin', false), [])
})
