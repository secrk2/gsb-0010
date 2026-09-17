import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { boot, login, api } from './helpers.js'
import { computeDueDate } from '../src/lib/deadlines.js'

let server
let base
const tokens = {}

before(async () => {
  ;({ server, base } = await boot())
  for (const u of ['admin', 'agent01', 'agent02', 'reviewer01', 'client01', 'client02']) {
    tokens[u] = await login(base, u)
  }
})

after(() => server.close())

const today = () => new Date().toISOString().slice(0, 10)

test('健康检查', async () => {
  const r = await fetch(`${base}/api/health`)
  const j = await r.json()
  assert.equal(r.status, 200)
  assert.equal(j.data.db, 'up')
  assert.equal(j.data.redis, 'up')
})

test('登录：错误密码 401，未带 token 401', async () => {
  const bad = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong' }),
  })
  assert.equal(bad.status, 401)
  assert.equal((await fetch(`${base}/api/cases`)).status, 401)
})

test('作战台：三家客户漏斗（八态）、逾期费用 3 笔、在办 9 件、返回时区与今日', async () => {
  const r = await api(base, tokens.admin).get('/dashboard')
  assert.equal(r.status, 200)
  const d = r.body.data
  assert.equal(d.funnels.length, 3)
  for (const f of d.funnels) {
    assert.equal(f.masked, true)
    assert.match(f.client_name, /^[A-Z]+·KH-\d{4}$/)
  }
  assert.equal(d.kpi.overdue_fees, 3)
  assert.equal(d.kpi.active_cases, 9) // 授权 2、驳回 1 已结案，其余 9 件在办
  assert.match(d.timezone, /\//)
  assert.match(d.local_today, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(d.deadlines.some((x) => x.overdue), '存在已逾期官文期限')
  // 期限携带口径快照
  const withBasis = d.deadlines.find((x) => x.base_type)
  assert.ok(withBasis, '至少一条带起算口径的官文派生期限')
  assert.ok(['receive', 'dispatch', 'manual'].includes(withBasis.base_type))
  // 双口径完成度
  assert.ok(d.completion.length > 0)
  assert.ok(d.completion[0].completion.documents.percent >= 0)
  assert.ok(d.completion[0].completion.stages.percent >= 0)
})

test('客户管理员：作战台仅本客户、名称不脱敏；越权 403', async () => {
  const c1 = api(base, tokens.client01)
  const d = (await c1.get('/dashboard')).body.data
  assert.equal(d.funnels.length, 1)
  assert.equal(d.funnels[0].masked, false)
  assert.equal(d.funnels[0].client_name, '华芯半导体科技有限公司')
  const cases = (await c1.get('/cases')).body.data
  assert.ok(cases.length > 0)
  assert.ok(cases.every((c) => c.client_id === 1))
  assert.equal((await c1.get('/cases/8')).status, 403)
  assert.equal((await c1.get('/clients/2')).status, 403)
  const own = await c1.get('/cases/1')
  assert.equal(own.status, 200)
  assert.equal(own.body.data.client_name, '华芯半导体科技有限公司')
})

test('脱敏：所内看实审案件为缩写，申请态案件明文；reveal 留痕', async () => {
  const agent = api(base, tokens.agent01)
  const cases = (await agent.get('/cases')).body.data
  const c1 = cases.find((c) => c.id === 1)
  assert.equal(c1.client_name, 'HX·KH-0001')
  assert.equal(c1.client_masked, true)
  // 案件 4 为申请态（未受理）→ 明文
  const c4 = cases.find((c) => c.id === 4)
  assert.equal(c4.client_masked, false)
  assert.equal(c4.client_name, '华芯半导体科技有限公司')
  assert.equal((await agent.post('/clients/1/reveal', { reason: '' })).status, 400)
  const reveal = await agent.post('/clients/1/reveal', { reason: '答复审查意见需核对申请人全称', case_id: 1 })
  assert.equal(reveal.status, 200)
  assert.equal(reveal.body.data.name, '华芯半导体科技有限公司')
  const logs = (await api(base, tokens.reviewer01).get('/logs/unmask')).body.data
  assert.ok(logs.some((l) => l.user_name === '李慕华' && l.reason.includes('核对申请人')))
})

test('官文驱动全链路：签约/派代理人前置、跳步与非法回退拦截、角色校验', async () => {
  const admin = api(base, tokens.admin)
  const cl = await admin.post('/clients', { name: '测试客户·量子计算研究院', short_code: 'QK', contact_name: '孙老师' })
  const clientId = cl.body.data.id
  const cs = await admin.post('/cases', { client_uuid: 'it-flow-0001', client_id: clientId, title: '量子纠错编码方法', ctype: '发明' })
  const caseId = cs.body.data.case.id
  assert.equal(cs.body.data.case.status, '申请')
  const regOa = (body) => admin.post(`/cases/${caseId}/office-actions`, { dispatch_date: today(), ...body })

  // 未签合同登记受理 → NO_CONTRACT
  assert.equal((await regOa({ oa_type: 'receipt', agent_id: 2 })).body.error.code, 'NO_CONTRACT')
  await admin.post(`/clients/${clientId}/contracts`, { title: '专利代理委托合同（量子院）', amount: 60000 })
  // 未派代理人 → NO_AGENT
  assert.equal((await regOa({ oa_type: 'receipt' })).body.error.code, 'NO_AGENT')
  // 受理（派 agent01=id2）
  const receipt = await regOa({ oa_type: 'receipt', agent_id: 2, reason: '' })
  assert.equal(receipt.status, 201)
  assert.equal((await admin.get(`/cases/${caseId}`)).body.data.status, '受理')
  // 跳步：受理态直接登记驳回决定 → ILLEGAL_TRANSITION
  const skip = await regOa({ oa_type: 'rejection' })
  assert.equal(skip.status, 409)
  assert.equal(skip.body.error.code, 'ILLEGAL_TRANSITION')
  // 非法回退：初审后再登记受理通知书 → ILLEGAL_ROLLBACK
  await regOa({ oa_type: 'preliminary_pass' })
  await regOa({ oa_type: 'enter_examination' })
  const rollback = await regOa({ oa_type: 'receipt' })
  assert.equal(rollback.status, 409)
  assert.equal(rollback.body.error.code, 'ILLEGAL_ROLLBACK')
  // 实审意见为过程性官文：不改状态，派生 4 个月答复期限（自推定收到日、自然日）
  const opinion = await regOa({ oa_type: 'examination_opinion' })
  assert.equal(opinion.status, 201)
  let detail = (await admin.get(`/cases/${caseId}`)).body.data
  assert.equal(detail.status, '实审')
  // 可登记官文不得包含复审/无效程序的决定（同名授权/驳回不可跨程序混用）
  const keys = detail.registerable_oa.map((o) => o.key)
  assert.ok(keys.includes('grant_notice') && keys.includes('rejection'))
  assert.ok(!keys.includes('reexamination_grant'))
  assert.ok(!keys.includes('invalidation_valid'))
  // 直接强提「复审改判授权」→ ILLEGAL_OA
  const bypass = await regOa({ oa_type: 'reexamination_grant' })
  assert.equal(bypass.status, 409)
  assert.equal(bypass.body.error.code, 'ILLEGAL_OA')
  // 复审意见在实审阶段不可登记
  assert.equal((await regOa({ oa_type: 'reexamination_opinion' })).body.error.code, 'ILLEGAL_OA')
  const derived = detail.deadlines.find((d) => d.source === 'office_action')
  assert.ok(derived)
  assert.equal(derived.base_type, 'receive')
  assert.equal(derived.day_basis, 'natural')
  const expect = computeDueDate({ dispatch_date: today(), base_type: 'receive', window_value: 4, window_unit: 'month', day_basis: 'natural' })
  assert.equal(derived.due_date, expect.due_date)
  // 驳回 → 非名下代理人登记复审受理 403，名下代理人 200（合法来回）
  await regOa({ oa_type: 'rejection' })
  assert.equal((await api(base, tokens.agent02).post(`/cases/${caseId}/office-actions`, { dispatch_date: today(), oa_type: 'reexamination_accept' })).status, 403)
  const reexam = await api(base, tokens.agent01).post(`/cases/${caseId}/office-actions`, { dispatch_date: today(), oa_type: 'reexamination_accept' })
  assert.equal(reexam.status, 201)
  assert.equal((await admin.get(`/cases/${caseId}`)).body.data.status, '复审')
  // 复审撤销驳回回实审 → 授权 → 无效受理 → 维持有效
  await regOa({ oa_type: 'reexamination_revoke' })
  await regOa({ oa_type: 'grant_notice' })
  await regOa({ oa_type: 'invalidation_accept' })
  detail = (await admin.get(`/cases/${caseId}`)).body.data
  assert.equal(detail.status, '无效')
  await regOa({ oa_type: 'invalidation_valid' })
  detail = (await admin.get(`/cases/${caseId}`)).body.data
  assert.equal(detail.status, '授权')
  // 客户管理员不能登记官文
  assert.equal((await api(base, tokens.client01).post(`/cases/${caseId}/office-actions`, { dispatch_date: today(), oa_type: 'other' })).status, 403)
})

test('官文撤回：原因必填留痕；过程性撤回作废派生期限；状态类撤回恢复案件状态', async () => {
  const admin = api(base, tokens.admin)
  // 用客户 1（已签约）新建案件并受理给 agent01
  const cs = await admin.post('/cases', { client_uuid: 'it-withdraw-1', client_id: 1, title: '撤回流程验证案件' })
  const caseId = cs.body.data.case.id
  await admin.post(`/cases/${caseId}/office-actions`, { dispatch_date: today(), oa_type: 'receipt', agent_id: 2 })
  await admin.post(`/cases/${caseId}/office-actions`, { dispatch_date: today(), oa_type: 'preliminary_pass' })
  await admin.post(`/cases/${caseId}/office-actions`, { dispatch_date: today(), oa_type: 'enter_examination' })
  const op = await admin.post(`/cases/${caseId}/office-actions`, { dispatch_date: today(), oa_type: 'examination_opinion' })
  const oaId = op.body.data.id
  let detail = (await admin.get(`/cases/${caseId}`)).body.data
  const dlId = detail.deadlines.find((d) => d.office_action_id === oaId).id
  // 无原因 → 400
  assert.equal((await admin.post(`/cases/${caseId}/office-actions/${oaId}/withdraw`, { reason: '' })).status, 400)
  // 带原因撤回过程性官文：状态仍为实审，派生期限作废
  const w = await admin.post(`/cases/${caseId}/office-actions/${oaId}/withdraw`, { reason: '审查意见文号登记错误，撤回后按更正文号重新登记' })
  assert.equal(w.status, 200)
  assert.equal(w.body.data.reverted_to, '实审')
  detail = (await admin.get(`/cases/${caseId}`)).body.data
  const dl = detail.deadlines.find((d) => d.id === dlId)
  assert.equal(dl.voided, true)
  // 撤回驳回决定：案件从驳回恢复到实审
  const rej = await admin.post(`/cases/${caseId}/office-actions`, { dispatch_date: today(), oa_type: 'rejection' })
  assert.equal((await admin.get(`/cases/${caseId}`)).body.data.status, '驳回')
  const rejOa = rej.body.data.id
  const w2 = await admin.post(`/cases/${caseId}/office-actions/${rejOa}/withdraw`, { reason: '驳回决定书文号张冠李戴，经与审查员核实撤回登记' })
  assert.equal(w2.body.data.reverted_to, '实审')
  assert.equal((await admin.get(`/cases/${caseId}`)).body.data.status, '实审')
  // 重复撤回 → 409
  assert.equal((await admin.post(`/cases/${caseId}/office-actions/${rejOa}/withdraw`, { reason: '再次撤回' })).body.error.code, 'OA_WITHDRAWN')
})

test('逾期办结：必须二次确认+原因，原因留痕；按期办结不需原因', async () => {
  const admin = api(base, tokens.admin)
  const detail = (await admin.get('/cases/5')).body.data
  const overdue = detail.deadlines.find((d) => d.overdue && d.status === '待处理')
  assert.ok(overdue, '种子案件 5 存在已逾期待办期限')
  // 未确认 → 409 NEED_OVERDUE_REASON
  const first = await admin.post(`/ops/deadlines/${overdue.id}/complete`, {})
  assert.equal(first.status, 409)
  assert.equal(first.body.error.code, 'NEED_OVERDUE_REASON')
  assert.ok(first.body.error.details.due_date)
  // 有确认无原因仍 409
  assert.equal((await admin.post(`/ops/deadlines/${overdue.id}/complete`, { confirmed: true, reason: '' })).status, 409)
  // 二次确认 + 原因 → 办结留痕
  const done = await admin.post(`/ops/deadlines/${overdue.id}/complete`, { confirmed: true, reason: '客户用印流程延误，已加急提交并取得回执' })
  assert.equal(done.status, 200)
  assert.equal(done.body.data.status, '已完成')
  assert.match(done.body.data.overdue_reason, /用印/)
  // 幂等：重复办结不覆盖留痕
  const again = await admin.post(`/ops/deadlines/${overdue.id}/complete`, { confirmed: true, reason: '不应覆盖' })
  assert.match(again.body.data.overdue_reason, /用印/)
})

test('幂等：client_uuid 去重，不产生重复案件', async () => {
  const admin = api(base, tokens.admin)
  const before1 = (await admin.get('/cases?client_id=2')).body.data.length
  const key = 'it-idem-key-1'
  const body = { client_uuid: 'it-idem-uuid-1', client_id: 2, title: '幂等测试案件A' }
  const p1 = await admin.post('/cases', body, { 'Idempotency-Key': key })
  const p2 = await admin.post('/cases', body, { 'Idempotency-Key': key })
  assert.equal(p1.status, 201)
  assert.equal(p2.headers.get('x-idempotent-replay'), 'true')
  assert.equal(p1.body.data.case.id, p2.body.data.case.id)
  const p3 = await admin.post('/cases', body, { 'Idempotency-Key': 'it-idem-key-2' })
  assert.equal(p3.status, 200)
  assert.equal(p3.body.data.deduped, true)
  const after1 = (await admin.get('/cases?client_id=2')).body.data.length
  assert.equal(after1, before1 + 1)
})

test('离线合并：官文登记 applied/duplicate/conflict，状态不被非法队列破坏', async () => {
  const admin = api(base, tokens.admin)
  // 案件 9 种子处于「受理」：离线登记初审合格 → applied；重放 → duplicate
  const batch1 = await admin.post('/sync/batch', {
    ops: [
      { key: 'sync-oa-1', op: 'oa.register', payload: { case_id: 9, oa_type: 'preliminary_pass', dispatch_date: today() } },
    ],
  })
  assert.equal(batch1.body.data.results[0].status, 'applied')
  const batch2 = await admin.post('/sync/batch', {
    ops: [
      { key: 'sync-oa-1', op: 'oa.register', payload: { case_id: 9, oa_type: 'preliminary_pass', dispatch_date: today() } },
    ],
  })
  assert.equal(batch2.body.data.results[0].status, 'duplicate')
  // 冲突：案件 9 已到初审，离线队列再来一条受理通知（目标受理=回退）→ conflict
  const batch3 = await admin.post('/sync/batch', {
    ops: [{ key: 'sync-oa-2', op: 'oa.register', payload: { case_id: 9, oa_type: 'receipt', dispatch_date: today(), agent_id: 3 } }],
  })
  assert.equal(batch3.body.data.results[0].status, 'conflict')
  assert.equal(batch3.body.data.results[0].code, 'ILLEGAL_ROLLBACK')
  assert.equal((await admin.get('/cases/9')).body.data.status, '初审')
  // 客户管理员无权同步
  assert.equal((await api(base, tokens.client01).post('/sync/batch', { ops: [] })).status, 403)
})

test('完成度：作战台/详情/导出三处一致，CSV 含双口径列', async () => {
  const admin = api(base, tokens.admin)
  const dash = (await admin.get('/dashboard')).body.data
  const item = dash.completion.find((x) => x.case_id === 5) // 多通实审意见仍在实审
  assert.ok(item.completion.documents.percent >= item.completion.stages.percent)
  const detail = (await admin.get('/cases/5')).body.data
  assert.equal(detail.completion.documents.percent, item.completion.documents.percent)
  assert.equal(detail.completion.stages.percent, item.completion.stages.percent)
  // 导出 CSV
  const r = await fetch(`${base}/api/export/cases.csv`, { headers: { Authorization: `Bearer ${tokens.admin}` } })
  assert.equal(r.status, 200)
  const csv = await r.text()
  assert.match(csv, /完成度-已归档官文数口径\(%\)/)
  assert.match(csv, /完成度-关键阶段数口径\(%\)/)
  const line5 = csv.split('\r\n').find((l) => l.startsWith('AL-2026-0005'))
  assert.ok(line5)
  // 导出数字与接口一致
  assert.ok(line5.includes(String(detail.completion.documents.percent)))
  assert.ok(line5.includes(String(detail.completion.stages.percent)))
})

test('日历接口：区间内期限与官文；按案件过滤；时区返回', async () => {
  const admin = api(base, tokens.admin)
  const r = await admin.get(`/calendar?from=2000-01-01&to=2099-01-01`)
  assert.equal(r.status, 200)
  assert.ok(r.body.data.deadlines.length > 0)
  assert.ok(r.body.data.office_actions.length > 0)
  const one = await admin.get(`/calendar?from=2000-01-01&to=2099-01-01&case_id=5`)
  assert.ok(one.body.data.deadlines.every((d) => d.case_id === 5))
  assert.ok(one.body.data.office_actions.every((d) => d.case_id === 5))
})

test('所级时区设置：非法时区 400；合法时区可更新', async () => {
  const admin = api(base, tokens.admin)
  assert.equal((await admin.req('PUT', '/settings', { timezone: 'Not/AZone' })).status, 400)
  const ok = await admin.req('PUT', '/settings', { timezone: 'Europe/London' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.data.timezone, 'Europe/London')
  const got = await admin.get('/settings')
  assert.equal(got.body.data.timezone, 'Europe/London')
  // 复位，避免影响其他用例
  await admin.req('PUT', '/settings', { timezone: 'Asia/Shanghai' })
  // 非管理员不可改
  assert.equal((await api(base, tokens.agent01).req('PUT', '/settings', { timezone: 'UTC' })).status, 403)
})

test('dashboard 缓存随写操作失效', async () => {
  const admin = api(base, tokens.admin)
  const before1 = (await admin.get('/dashboard')).body.data.kpi.active_cases
  await admin.post('/cases', { client_uuid: 'it-cache-0001', client_id: 1, title: '缓存失效验证案件' })
  const after1 = (await admin.get('/dashboard')).body.data.kpi.active_cases
  assert.equal(after1, before1 + 1)
})
