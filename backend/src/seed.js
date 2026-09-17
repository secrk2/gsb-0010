import bcrypt from 'bcryptjs'
import { query, tx } from './db.js'
import { config } from './config.js'
import { nowIso, daysFromNow } from './lib/dates.js'
import { computeDueDate } from './lib/deadlines.js'
import { OA_TYPES } from './lib/oaCatalog.js'

// 首次启动（users 表为空）时写入演示业务数据：
// 3 家委托客户、三类账号、覆盖八态的案件、由官文链驱动的状态与期限，
// 并预置：撤回官文案（官文全撤回空态）、法定节假日口径期限、逾期办结留痕、临近/逾期期限与费用。
// 日期全部相对当前时间生成，任何时候 compose up 都是「真实在办」的状态。

const daysAgoIso = (n) => nowIso(new Date(Date.now() - n * 86400000))
const daysAgoDate = (n) => daysFromNow(-n)
const dayDate = (n) => daysFromNow(n)

export async function seedIfEmpty() {
  const rows = await query('SELECT COUNT(*) AS n FROM users')
  if (Number(rows[0].n) > 0) return false
  console.log('[seed] 空库，写入初始业务数据…')
  const hash = bcrypt.hashSync('Patent@123', config.bcryptRounds)
  const now = nowIso()

  // 插入一条官文及其派生期限/流转事件；返回插入的期限行信息
  async function insertOa(d, { caseId, type, dispatchAgo, actorId, actorName, withdrawn = false, withdrawReason = '', docNo = '' }) {
    const def = OA_TYPES[type]
    const dispatchDate = daysAgoDate(dispatchAgo)
    const oaId = await d.insert(
      `INSERT INTO office_actions
       (case_id, oa_type, doc_no, title, dispatch_date, receive_date, presumed_days, receive_presumed, target_status, status, withdraw_reason, note, created_by, created_by_name, created_at, withdrawn_at, withdrawn_by, withdrawn_by_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [caseId, def.key, docNo, def.label, dispatchDate, null, 15, 1, def.target, withdrawn ? 'withdrawn' : 'active', withdrawReason, '', actorId, actorName, daysAgoIso(Math.max(0, dispatchAgo - 1)),
       withdrawn ? daysAgoIso(Math.max(0, dispatchAgo - 2)) : null, withdrawn ? actorId : null, withdrawn ? actorName : '']
    )
    if (withdrawn) return { oaId, deadlines: [] }
    const dls = []
    for (const tpl of def.deadlines) {
      const r = computeDueDate({ dispatch_date: dispatchDate, base_type: tpl.base_type, window_value: tpl.window_value, window_unit: tpl.window_unit, day_basis: tpl.day_basis })
      const dlId = await d.insert(
        `INSERT INTO deadlines (case_id, dtype, due_date, status, note, created_at, source, office_action_id, base_type, base_date, day_basis, window_value, window_unit, receive_presumed, rolled_forward)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [caseId, tpl.title, r.due_date, '待处理', '', daysAgoIso(Math.max(0, dispatchAgo - 1)), 'office_action', oaId, tpl.base_type, r.base_date, tpl.day_basis, tpl.window_value, tpl.window_unit, r.receive_presumed ? 1 : 0, r.rolled_forward ? 1 : 0]
      )
      dls.push({ id: dlId, due: r.due_date })
    }
    return { oaId, deadlines: dls }
  }

  async function insertManualDeadline(d, { caseId, title, dueInDays, status = '待处理', note = '', completedAgo = null, overdueReason = '', base = null }) {
    let dueDate = dayDate(dueInDays)
    let baseType = 'manual', baseDate = null, dayBasis = null, wv = null, wu = null, presumed = 0, rolled = 0
    if (base) {
      const r = computeDueDate({ dispatch_date: daysAgoDate(base.dispatchAgo), base_type: base.base_type, window_value: base.window_value, window_unit: base.window_unit || 'day', day_basis: base.day_basis })
      dueDate = r.due_date
      baseType = base.base_type; baseDate = r.base_date; dayBasis = base.day_basis; wv = base.window_value; wu = base.window_unit || 'day'; presumed = r.receive_presumed ? 1 : 0; rolled = r.rolled_forward ? 1 : 0
    }
    return d.insert(
      `INSERT INTO deadlines (case_id, dtype, due_date, status, note, completed_at, created_at, source, base_type, base_date, day_basis, window_value, window_unit, receive_presumed, rolled_forward, completed_by, completed_by_name, overdue_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [caseId, title, dueDate, status, note, completedAgo != null ? daysAgoIso(completedAgo) : null, daysAgoIso(20), 'manual', baseType, baseDate, dayBasis, wv, wu, presumed, rolled,
       completedAgo != null ? 4 : null, completedAgo != null ? '郑严' : '', overdueReason]
    )
  }

  await tx(async (d) => {
    // ---- 账号（密码均为 Patent@123）----
    const users = [
      ['admin', '周正', 'admin', null],
      ['agent01', '李慕华', 'agent', null],
      ['agent02', '陈远', 'agent', null],
      ['reviewer01', '郑严', 'reviewer', null],
      ['client01', '王工', 'client_admin', 1],
      ['client02', '陈博士', 'client_admin', 2],
      ['client03', '赵经理', 'client_admin', 3],
    ]
    for (const [username, name, role, clientId] of users) {
      await d.insert('INSERT INTO users (username, password_hash, name, role, client_id, created_at) VALUES (?,?,?,?,?,?)', [
        username, hash, name, role, clientId, now,
      ])
    }

    // ---- 客户建档 ----
    const clients = [
      ['KH-0001', '华芯半导体科技有限公司', 'HX', '王工', '13800000001', 'wang@huaxin.example'],
      ['KH-0002', '蓝湾生物医药股份公司', 'LW', '陈博士', '13800000002', 'chen@lanwan.example'],
      ['KH-0003', '星野智能装备有限公司', 'XY', '赵经理', '13800000003', 'zhao@xingye.example'],
    ]
    for (const [code, name, short, contact, phone, email] of clients) {
      await d.insert(
        'INSERT INTO clients (code, name, short_code, contact_name, contact_phone, contact_email, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [code, name, short, contact, phone, email, '已签约', daysAgoIso(150)]
      )
    }

    // ---- 委托合同 ----
    const contracts = [
      ['HT-2026-001', 1, '专利代理委托合同（华芯）', 120000],
      ['HT-2026-002', 2, '专利代理委托合同（蓝湾）', 96000],
      ['HT-2026-003', 3, '专利代理委托合同（星野）', 88000],
    ]
    for (const [no, cid, title, amount] of contracts) {
      await d.insert(
        'INSERT INTO contracts (contract_no, client_id, title, amount, status, signed_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [no, cid, title, amount, '已签署', daysAgoIso(140), 1, daysAgoIso(140)]
      )
    }

    // ---- 案件 ----
    // [uuid, client_id, contract_id, title, ctype, status, agent_id, priority, createdAgo]
    const cases = [
      ['seed-case-0001', 1, 1, '一种芯片散热结构及其制备方法', '发明', '实审', 2, '高', 120],
      ['seed-case-0002', 1, 1, '半导体封装测试方法', '发明', '授权', 2, '普通', 300],
      ['seed-case-0003', 1, 1, '晶圆清洗装置', '实用新型', '申请', 3, '普通', 20],
      ['seed-case-0004', 1, 1, '测试探针卡结构', '发明', '申请', null, '高', 3],
      ['seed-case-0005', 2, 2, '抗体药物偶联物的制备方法', '发明', '实审', 3, '高', 100],
      ['seed-case-0006', 2, 2, '细胞培养生物反应器', '实用新型', '复审', 2, '普通', 200],
      ['seed-case-0007', 2, 2, '冻干制剂工艺', '发明', '驳回', 3, '普通', 180],
      ['seed-case-0008', 3, 3, '工业机器人关节模组', '发明', '实审', 2, '高', 90],
      ['seed-case-0009', 3, 3, '视觉分拣系统', '发明', '受理', 3, '普通', 15],
      ['seed-case-0010', 3, 3, '物流AGV调度方法', '发明', '申请', null, '普通', 2],
      ['seed-case-0011', 3, 3, '机械臂末端夹具', '外观设计', '授权', 2, '普通', 260],
      ['seed-case-0012', 3, 3, '传送带张紧机构', '实用新型', '无效', 3, '普通', 160],
    ]
    let caseSeq = 0
    for (const [uuid, cid, contractId, title, ctype, status, agentId, priority, createdAgo] of cases) {
      caseSeq++
      await d.insert(
        `INSERT INTO cases (case_no, client_uuid, client_id, contract_id, title, ctype, status, agent_id, priority, version, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [`AL-2026-${String(caseSeq).padStart(4, '0')}`, uuid, cid, contractId, title, ctype, status, agentId, priority, 1, 1, daysAgoIso(createdAgo), daysAgoIso(Math.max(0, createdAgo - 30))]
      )
      await d.insert(
        'INSERT INTO case_events (case_id, from_status, to_status, action, actor_id, actor_name, reason, event_source, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [caseSeq, null, '申请', '创建申请', 1, '周正', '', 'manual', daysAgoIso(createdAgo)]
      )
    }

    // 登记官文链的助手：依次插入官文 + 流转事件；completeDerived 中给定期限序号标记已完成
    async function chain(caseId, links, { actor = 1, name = '周正' } = {}) {
      let prev = '申请'
      for (const link of links) {
        const [type, ago, completeDerived = []] = link
        const r = await insertOa(d, { caseId, type, dispatchAgo: ago, actorId: actor, actorName: name })
        const target = OA_TYPES[type].target
        if (target) {
          await d.insert(
            'INSERT INTO case_events (case_id, from_status, to_status, action, actor_id, actor_name, reason, event_source, ref_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [caseId, prev, target, `登记${OA_TYPES[type].label}`, actor, name, '', 'office_action', r.oaId, daysAgoIso(Math.max(0, ago - 1))]
          )
          prev = target
        }
        for (const idx of completeDerived) {
          const dl = r.deadlines[idx]
          if (dl) await d.query("UPDATE deadlines SET status = '已完成', completed_at = ?, completed_by = ?, completed_by_name = ? WHERE id = ?", [daysAgoIso(Math.max(0, ago - 5)), actor, name, dl.id])
        }
      }
    }

    // 1 实审（两通实审意见，第二通答复临近）
    await chain(1, [['receipt', 118], ['preliminary_pass', 100], ['enter_examination', 85], ['examination_opinion', 75, [0]], ['examination_opinion', 20]])
    await insertManualDeadline(d, { caseId: 1, title: '答复第二次审查意见通知书', dueInDays: 5, note: '涉及权利要求1-3创造性' })

    // 2 授权（办登期限已完成，年费待缴）
    await chain(2, [['receipt', 298], ['preliminary_pass', 250], ['enter_examination', 230], ['grant_notice', 200, [0]]])
    await insertManualDeadline(d, { caseId: 2, title: '缴纳第3年年费', dueInDays: 25 })

    // 3 申请：受理通知曾登记后撤回（官文全撤回 → 状态恢复申请，派生期限作废）
    {
      const r = await insertOa(d, { caseId: 3, type: 'receipt', dispatchAgo: 18, actorId: 1, actorName: '周正', withdrawn: true, withdrawReason: '客户名称变更中，受理通知书申请人信息待国局更正后重新登记' })
      await d.insert(
        'INSERT INTO case_events (case_id, from_status, to_status, action, actor_id, actor_name, reason, event_source, ref_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [3, '受理', '申请', '撤回官文（受理通知书）', 1, '周正', '客户名称变更中，受理通知书申请人信息待国局更正后重新登记', 'withdraw', r.oaId, daysAgoIso(16)]
      )
    }

    // 5 实审（含逾期已办结留痕 + 一条已逾期待办）
    await chain(5, [['receipt', 98], ['preliminary_pass', 85], ['enter_examination', 70], ['examination_opinion', 60], ['examination_opinion', 18]])
    await insertManualDeadline(d, { caseId: 5, title: '答复第二次审查意见通知书', dueInDays: 2, note: '需补充对比实验数据' })
    await insertManualDeadline(d, { caseId: 5, title: '补充实验数据提交', dueInDays: -3, note: '审查员要求的补充数据' })
    await insertManualDeadline(d, {
      caseId: 5, title: '答复第一次审查意见通知书', dueInDays: -12, status: '已完成', completedAgo: 8,
      overdueReason: '客户内部技术评审延迟；已于到期后第4日加急邮寄并取得邮局回执，已向审查员电话说明',
    })

    // 6 复审（驳回→复审受理，复审意见答复期限在办）
    await chain(6, [['receipt', 198], ['preliminary_pass', 180], ['enter_examination', 160], ['rejection', 120, [0]], ['reexamination_accept', 100], ['reexamination_opinion', 20]])
    await insertManualDeadline(d, { caseId: 6, title: '复审口头审理准备', dueInDays: 20, note: '线上口审' })

    // 7 驳回（复审请求三个月期限在办）
    await chain(7, [['receipt', 178], ['preliminary_pass', 160], ['enter_examination', 140], ['rejection', 30]])
    await insertManualDeadline(d, { caseId: 7, title: '复审请求期限（提示用）', dueInDays: 15, note: '驳回决定推定收到日起三个月内，以官文派生期限为准' })

    // 8 实审：法定节假日口径期限（推定收到日起算，跳过中秋/国庆与调休）
    await chain(8, [['receipt', 88], ['preliminary_pass', 70], ['enter_examination', 55], ['examination_opinion', 3]])
    await insertManualDeadline(d, {
      caseId: 8, title: '答复审查意见通知书（法定节假日口径）', dueInDays: 0, // due 由 base 推算后在下方修正
      note: '自推定收到日起算，法定节假日口径：中秋/国庆休假日不计入',
      base: { dispatchAgo: 3, base_type: 'receive', window_value: 20, day_basis: 'legal' },
    })
    // 再补一条 12 自然日的近期待办，便于作战台演示
    await insertManualDeadline(d, { caseId: 8, title: '答复审查意见通知书（自然日口径）', dueInDays: 12, note: '客户要求按自然日口径内部预警' })

    // 9 受理（仅受理通知书）
    await chain(9, [['receipt', 14]])
    await insertManualDeadline(d, { caseId: 9, title: '确认申请文本', dueInDays: 4 })

    // 11 授权（办登已完成；一条登记手续手工期限已逾期，用于红点演示）
    await chain(11, [['receipt', 258], ['preliminary_pass', 230], ['enter_examination', 210], ['grant_notice', 90, [0]]])
    await insertManualDeadline(d, { caseId: 11, title: '办理登记手续（人工补录预警）', dueInDays: -1, note: '授权通知书已下发，请核对办登状态' })

    // 12 无效（授权后被提无效，无效答复期限在办）
    await chain(12, [['receipt', 158], ['preliminary_pass', 140], ['enter_examination', 120], ['grant_notice', 100, [0]], ['invalidation_accept', 8]])
    await insertManualDeadline(d, { caseId: 12, title: '无效宣告答复意见陈述（人工预警）', dueInDays: 8 })

    // ---- 费用（含逾期红点）----
    const fees = [
      [1, '实质审查费', 2500, -2, false],
      [5, '答复代理费', 3000, -5, false],
      [12, '复审/无效应答费', 1000, -1, false],
      [2, '第3年年费', 900, 25, false],
      [9, '代理费', 5000, 10, false],
      [8, '申请费', 900, -10, true],
      [11, '登记费', 200, -20, true],
    ]
    for (const [caseId, kind, amount, due, paid] of fees) {
      await d.insert('INSERT INTO fees (case_id, kind, amount, due_date, status, paid_at, created_at) VALUES (?,?,?,?,?,?,?)', [
        caseId, kind, amount, dayDate(due), paid ? '已缴' : '待缴', paid ? daysAgoIso(Math.abs(due) + 2) : null, daysAgoIso(30),
      ])
    }

    // ---- 所级默认设置：代理所时区 ----
    await d.insert('INSERT INTO kv_settings (k, v, updated_at, updated_by) VALUES (?,?,?,?)', ['firm.timezone', 'Asia/Shanghai', now, 1])
  })
  console.log('[seed] 完成：3 家客户 / 7 个账号 / 12 件案件 / 八态官文链（含 1 件全撤回）/ 法定口径期限 / 逾期办结留痕 / 7 条费用')
  return true
}
