import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { boot, login, api } from './helpers.js'

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
  const noToken = await fetch(`${base}/api/cases`)
  assert.equal(noToken.status, 401)
})

test('作战台：3 家客户漏斗，所内视角客户名已脱敏，逾期费用 3 笔', async () => {
  const r = await api(base, tokens.admin).get('/dashboard')
  assert.equal(r.status, 200)
  const d = r.body.data
  assert.equal(d.funnels.length, 3)
  for (const f of d.funnels) {
    assert.equal(f.masked, true)
    assert.match(f.client_name, /^[A-Z]+·KH-\d{4}$/)
  }
  assert.equal(d.kpi.overdue_fees, 3)
  assert.equal(d.kpi.active_cases, 9) // 12 件案件：授权 2、驳回 1 已结案，其余 9 件在办
  assert.ok(d.deadlines.length > 0)
  assert.ok(d.deadlines.some((x) => x.overdue), '存在已逾期官文期限')
  // 逾期费用按到期日升序，含案件与客户信息
  assert.ok(d.overdue_fees[0].case_no)
})

test('客户管理员：作战台与列表仅见本客户，且名称不脱敏', async () => {
  const d = (await api(base, tokens.client01).get('/dashboard')).body.data
  assert.equal(d.funnels.length, 1)
  assert.equal(d.funnels[0].masked, false)
  assert.equal(d.funnels[0].client_name, '华芯半导体科技有限公司')
  const clients = (await api(base, tokens.client01).get('/clients')).body.data
  assert.equal(clients.length, 1)
  assert.equal(clients[0].name, '华芯半导体科技有限公司')
})

test('客户隔离：越权访问他人案件/客户一律 403（非空白）', async () => {
  const c1 = api(base, tokens.client01)
  // client01 只能看到本客户（client_id=1）的案件
  const cases = (await c1.get('/cases')).body.data
  assert.ok(cases.length > 0)
  assert.ok(cases.every((c) => c.client_id === 1))
  // 越权：星野（client_id=3）的案件 id=8
  const forbidden = await c1.get('/cases/8')
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.body.error.code, 'FORBIDDEN')
  assert.match(forbidden.body.error.message, /无权访问其他客户/)
  // 越权：他人客户详情
  assert.equal((await c1.get('/clients/2')).status, 403)
  assert.equal((await c1.get('/clients/3')).status, 403)
  // 越权：对他人案件做流转
  const t = await c1.post('/cases/8/transition', { to: '实审中' })
  assert.equal(t.status, 403)
  // 本客户案件详情正常
  const own = await c1.get('/cases/1')
  assert.equal(own.status, 200)
  assert.equal(own.body.data.client_name, '华芯半导体科技有限公司')
})

test('委托→签约→立项→实审 全链路 + 非法回退拦截', async () => {
  const admin = api(base, tokens.admin)
  // 1. 客户建档
  const cl = await admin.post('/clients', { name: '测试客户·量子计算研究院', short_code: 'QK', contact_name: '孙老师' })
  assert.equal(cl.status, 201)
  const clientId = cl.body.data.id
  assert.match(cl.body.data.code, /^KH-\d{4}$/)
  // 2. 未签合同先建委托案件（允许，状态=委托中）
  const cs = await admin.post('/cases', { client_uuid: 'it-flow-0001', client_id: clientId, title: '量子纠错编码方法', ctype: '发明' })
  assert.equal(cs.status, 201)
  const caseId = cs.body.data.case.id
  assert.equal(cs.body.data.case.status, '委托中')
  // 3. 未签合同立项 → 409 说明原因
  const noContract = await admin.post(`/cases/${caseId}/transition`, { to: '已立项', agent_id: 2 })
  assert.equal(noContract.status, 409)
  assert.equal(noContract.body.error.code, 'NO_CONTRACT')
  assert.match(noContract.body.error.message, /委托合同/)
  // 4. 签订合同
  const ct = await admin.post(`/clients/${clientId}/contracts`, { title: '专利代理委托合同（量子院）', amount: 60000 })
  assert.equal(ct.status, 201)
  assert.match(ct.body.data.contract_no, /^HT-\d{4}-\d{3}$/)
  // 重复签约 → 409
  assert.equal((await admin.post(`/clients/${clientId}/contracts`, { title: 'x' })).status, 409)
  // 5. 立项未派代理人 → 409
  const noAgent = await admin.post(`/cases/${caseId}/transition`, { to: '已立项' })
  assert.equal(noAgent.status, 409)
  assert.equal(noAgent.body.error.code, 'NO_AGENT')
  // 6. 正常立项（派李慕华 agent01=id2）
  const init = await admin.post(`/cases/${caseId}/transition`, { to: '已立项', agent_id: 2, reason: '新案分配' })
  assert.equal(init.status, 200)
  assert.equal(init.body.data.case.status, '已立项')
  // 7. 非法回退：已立项 → 委托中
  const back = await admin.post(`/cases/${caseId}/transition`, { to: '委托中' })
  assert.equal(back.status, 409)
  assert.equal(back.body.error.code, 'ILLEGAL_ROLLBACK')
  assert.match(back.body.error.message, /非法回退/)
  // 8. 跳级：已立项 → 授权
  const skip = await admin.post(`/cases/${caseId}/transition`, { to: '授权' })
  assert.equal(skip.status, 409)
  assert.equal(skip.body.error.code, 'ILLEGAL_TRANSITION')
  // 9. 非名下代理人提交实审 → 403；名下代理人 → 200
  const stranger = await api(base, tokens.agent02).post(`/cases/${caseId}/transition`, { to: '实审中' })
  assert.equal(stranger.status, 403)
  assert.equal(stranger.body.error.code, 'NOT_ASSIGNEE')
  const owner = await api(base, tokens.agent01).post(`/cases/${caseId}/transition`, { to: '实审中' })
  assert.equal(owner.status, 200)
  assert.equal(owner.body.data.case.status, '实审中')
  // 10. 实审中 → 已立项（回退）→ 409；代理人登记授权 → 403；审核员登记授权 → 200
  assert.equal((await admin.post(`/cases/${caseId}/transition`, { to: '已立项' })).status, 409)
  assert.equal((await api(base, tokens.agent01).post(`/cases/${caseId}/transition`, { to: '授权' })).status, 403)
  const grant = await api(base, tokens.reviewer01).post(`/cases/${caseId}/transition`, { to: '授权', reason: '授权通知书已发文' })
  assert.equal(grant.status, 200)
  // 11. 流转事件完整留痕
  const detail = await admin.get(`/cases/${caseId}`)
  const actions = detail.body.data.events.map((e) => e.action)
  assert.deepEqual(actions, ['创建委托', '立项', '提交实审', '授权登记'])
})

test('脱敏与留痕：代理人二次确认填理由看全名', async () => {
  const agent = api(base, tokens.agent01)
  // 列表中：实审案件脱敏，委托中案件明文
  const cases = (await agent.get('/cases')).body.data
  const c1 = cases.find((c) => c.id === 1)
  assert.equal(c1.client_name, 'HX·KH-0001')
  assert.equal(c1.client_masked, true)
  const c4 = cases.find((c) => c.id === 4)
  assert.equal(c4.client_name, '华芯半导体科技有限公司')
  assert.equal(c4.client_masked, false)
  // 无理由 → 400
  assert.equal((await agent.post('/clients/1/reveal', { reason: '' })).status, 400)
  // 填理由 → 返回全名
  const reveal = await agent.post('/clients/1/reveal', { reason: '答复审查意见需核对申请人全称', case_id: 1 })
  assert.equal(reveal.status, 200)
  assert.equal(reveal.body.data.name, '华芯半导体科技有限公司')
  assert.equal(reveal.body.data.logged, true)
  // 留痕可被审核员查到
  const logs = (await api(base, tokens.reviewer01).get('/logs/unmask')).body.data
  assert.ok(logs.some((l) => l.user_name === '李慕华' && l.reason.includes('核对申请人')))
  // 客户管理员无权调用 reveal 接口（其本客户数据本就不脱敏）
  assert.equal((await api(base, tokens.client01).post('/clients/1/reveal', { reason: '看看' })).status, 403)
  // 客户管理员也无权看留痕日志
  assert.equal((await api(base, tokens.client01).get('/logs/unmask')).status, 403)
})

test('幂等：Idempotency-Key 重放与 client_uuid 去重，不产生重复案件', async () => {
  const admin = api(base, tokens.admin)
  const before1 = (await admin.get('/cases?client_id=2')).body.data.length
  // 同一 key 重复提交 → 回放首次响应
  const key = 'it-idem-key-1'
  const p1 = await admin.post('/cases', { client_uuid: 'it-idem-uuid-1', client_id: 2, title: '幂等测试案件A' }, { 'Idempotency-Key': key })
  const p2 = await admin.post('/cases', { client_uuid: 'it-idem-uuid-1', client_id: 2, title: '幂等测试案件A' }, { 'Idempotency-Key': key })
  assert.equal(p1.status, 201)
  assert.equal(p2.status, 201) // 回放首次状态码
  assert.equal(p2.headers.get('x-idempotent-replay'), 'true')
  assert.equal(p1.body.data.case.id, p2.body.data.case.id)
  // 不同 key 但相同 client_uuid（离线重试场景）→ 去重返回同一案件
  const p3 = await admin.post('/cases', { client_uuid: 'it-idem-uuid-1', client_id: 2, title: '幂等测试案件A' }, { 'Idempotency-Key': 'it-idem-key-2' })
  assert.equal(p3.status, 200)
  assert.equal(p3.body.data.deduped, true)
  assert.equal(p3.body.data.case.id, p1.body.data.case.id)
  const after1 = (await admin.get('/cases?client_id=2')).body.data.length
  assert.equal(after1, before1 + 1, '三次提交只产生一件案件')
})

test('离线合并：批量同步幂等去重 + 冲突带回服务器现状', async () => {
  const admin = api(base, tokens.admin)
  // 客户管理员无权走同步通道
  assert.equal((await api(base, tokens.client01).post('/sync/batch', { ops: [] })).status, 403)
  // 模拟出差离线期间排队：新建案件 + 立项
  const batch1 = await admin.post('/sync/batch', {
    ops: [
      { key: 'sync-k1', op: 'case.create', payload: { client_uuid: 'it-sync-uuid-1', client_id: 3, title: '离线新建·巡检机器人路径规划' } },
      { key: 'sync-k2', op: 'case.transition', payload: { case_id: 9, to: '实审中', reason: '出差途中收到受理通知' } },
    ],
  })
  assert.equal(batch1.status, 200)
  const [r1, r2] = batch1.body.data.results
  assert.equal(r1.status, 'applied')
  assert.equal(r2.status, 'applied')
  const newCaseId = r1.data.case_id
  // 恢复后前端重试同一批（网络抖动场景）→ 全部 duplicate，不产生重复案件
  const batch2 = await admin.post('/sync/batch', {
    ops: [
      { key: 'sync-k1', op: 'case.create', payload: { client_uuid: 'it-sync-uuid-1', client_id: 3, title: '离线新建·巡检机器人路径规划' } },
      { key: 'sync-k2', op: 'case.transition', payload: { case_id: 9, to: '实审中' } },
    ],
  })
  assert.equal(batch2.body.data.results[0].status, 'duplicate')
  assert.equal(batch2.body.data.results[1].status, 'duplicate')
  const starCases = (await admin.get('/cases?client_id=3')).body.data
  assert.equal(starCases.filter((c) => c.client_uuid === 'it-sync-uuid-1').length, 1)
  // 冲突：服务器上案件 9 已是「实审中」，离线队列里还有一条「回到已立项」→ conflict
  const batch3 = await admin.post('/sync/batch', {
    ops: [{ key: 'sync-k3', op: 'case.transition', payload: { case_id: 9, to: '已立项' } }],
  })
  const [r3] = batch3.body.data.results
  assert.equal(r3.status, 'conflict')
  assert.equal(r3.code, 'ILLEGAL_ROLLBACK')
  // 服务器状态未被破坏
  const c9 = (await admin.get('/cases/9')).body.data
  assert.equal(c9.status, '实审中')
  // 离线期间对同一新案件的重复创建（不同 key 同 uuid）→ duplicate
  const batch4 = await admin.post('/sync/batch', {
    ops: [{ key: 'sync-k4', op: 'case.create', payload: { client_uuid: 'it-sync-uuid-1', client_id: 3, title: '离线新建·巡检机器人路径规划' } }],
  })
  assert.equal(batch4.body.data.results[0].status, 'duplicate')
  assert.equal(batch4.body.data.results[0].data.case_id, newCaseId)
})

test('期限与费用：完成/缴纳幂等', async () => {
  const admin = api(base, tokens.admin)
  const d1 = await admin.post('/ops/deadlines/1/complete')
  assert.equal(d1.body.data.status, '已完成')
  const d2 = await admin.post('/ops/deadlines/1/complete')
  assert.equal(d2.body.data.status, '已完成')
  assert.equal(d1.body.data.completed_at, d2.body.data.completed_at)
  const f1 = await admin.post('/ops/fees/1/pay')
  assert.equal(f1.body.data.status, '已缴')
  const f2 = await admin.post('/ops/fees/1/pay')
  assert.equal(f2.body.data.status, '已缴')
  assert.equal(f1.body.data.paid_at, f2.body.data.paid_at)
})

test('dashboard 缓存随写操作失效', async () => {
  const admin = api(base, tokens.admin)
  const before1 = (await admin.get('/dashboard')).body.data.kpi.active_cases
  await admin.post('/cases', { client_uuid: 'it-cache-0001', client_id: 1, title: '缓存失效验证案件' })
  const after1 = (await admin.get('/dashboard')).body.data.kpi.active_cases
  assert.equal(after1, before1 + 1)
})
