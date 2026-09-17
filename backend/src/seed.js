import bcrypt from 'bcryptjs'
import { query, tx } from './db.js'
import { config } from './config.js'
import { nowIso, daysFromNow } from './lib/dates.js'

// 首次启动（users 表为空）时写入演示业务数据：
// 3 家委托客户、三类账号、覆盖全部状态的案件、临近/逾期官文期限与费用。
// 日期全部相对当前时间生成，任何时候 compose up 都是「真实在办」的状态。

const daysAgoIso = (n) => nowIso(new Date(Date.now() - n * 86400000))

export async function seedIfEmpty() {
  const rows = await query('SELECT COUNT(*) AS n FROM users')
  if (Number(rows[0].n) > 0) return false
  console.log('[seed] 空库，写入初始业务数据…')
  const hash = bcrypt.hashSync('Patent@123', config.bcryptRounds)
  const now = nowIso()

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

    // ---- 案件（client_uuid 固定，重复执行 seed 也不会重复）----
    // [uuid, client_id, contract_id, title, ctype, status, agent_id, priority, createdDaysAgo]
    const cases = [
      ['seed-case-0001', 1, 1, '一种芯片散热结构及其制备方法', '发明', '实审中', 2, '高', 120],
      ['seed-case-0002', 1, 1, '半导体封装测试方法', '发明', '授权', 2, '普通', 300],
      ['seed-case-0003', 1, 1, '晶圆清洗装置', '实用新型', '已立项', 3, '普通', 20],
      ['seed-case-0004', 1, 1, '测试探针卡结构', '发明', '委托中', null, '高', 3],
      ['seed-case-0005', 2, 2, '抗体药物偶联物的制备方法', '发明', '实审中', 3, '高', 100],
      ['seed-case-0006', 2, 2, '细胞培养生物反应器', '实用新型', '复审中', 2, '普通', 200],
      ['seed-case-0007', 2, 2, '冻干制剂工艺', '发明', '驳回', 3, '普通', 180],
      ['seed-case-0008', 3, 3, '工业机器人关节模组', '发明', '实审中', 2, '高', 90],
      ['seed-case-0009', 3, 3, '视觉分拣系统', '发明', '已立项', 3, '普通', 15],
      ['seed-case-0010', 3, 3, '物流AGV调度方法', '发明', '委托中', null, '普通', 2],
      ['seed-case-0011', 3, 3, '机械臂末端夹具', '外观设计', '授权', 2, '普通', 260],
      ['seed-case-0012', 3, 3, '传送带张紧机构', '实用新型', '复审中', 3, '普通', 160],
    ]
    // 状态路径：用于生成流转事件
    const PATH = {
      委托中: ['委托中'],
      已立项: ['委托中', '已立项'],
      实审中: ['委托中', '已立项', '实审中'],
      授权: ['委托中', '已立项', '实审中', '授权'],
      驳回: ['委托中', '已立项', '实审中', '驳回'],
      复审中: ['委托中', '已立项', '实审中', '驳回', '复审中'],
    }
    const ACTION = { 委托中: '创建委托', 已立项: '立项', 实审中: '提交实审', 授权: '授权登记', 驳回: '驳回登记', 复审中: '提起复审' }
    let caseSeq = 0
    for (const [uuid, cid, contractId, title, ctype, status, agentId, priority, createdAgo] of cases) {
      caseSeq++
      const id = await d.insert(
        `INSERT INTO cases (case_no, client_uuid, client_id, contract_id, title, ctype, status, agent_id, priority, version, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [`AL-2026-${String(caseSeq).padStart(4, '0')}`, uuid, cid, contractId, title, ctype, status, agentId, priority, PATH[status].length, 1, daysAgoIso(createdAgo), daysAgoIso(Math.max(0, createdAgo - 30))]
      )
      const path = PATH[status]
      for (let i = 0; i < path.length; i++) {
        await d.insert(
          'INSERT INTO case_events (case_id, from_status, to_status, action, actor_id, actor_name, reason, created_at) VALUES (?,?,?,?,?,?,?,?)',
          [id, i === 0 ? null : path[i - 1], path[i], ACTION[path[i]], 1, '周正', '', daysAgoIso(Math.max(0, createdAgo - i * 25))]
        )
      }
    }

    // ---- 官文期限（含临近与逾期）----
    // [caseId, dtype, dueInDays, note]
    const deadlines = [
      [1, '答复第一次审查意见通知书', 5, '涉及权利要求1-3创造性'],
      [5, '答复第二次审查意见通知书', 2, '需补充对比实验数据'],
      [5, '补充实验数据提交', -3, '审查员要求的补充数据'],
      [8, '答复审查意见通知书', 12, ''],
      [6, '复审口头审理', 20, '线上口审'],
      [12, '复审补充理由陈述', 8, ''],
      [2, '缴纳第3年年费', 25, ''],
      [3, '提交申请文件', 6, '待客户确认最终文本'],
      [9, '确认申请文本', 4, ''],
      [7, '复审请求期限', 15, '驳回决定之日起三个月内'],
      [11, '办理登记手续', -1, '授权通知书已下发'],
    ]
    for (const [caseId, dtype, due, note] of deadlines) {
      await d.insert('INSERT INTO deadlines (case_id, dtype, due_date, status, note, created_at) VALUES (?,?,?,?,?,?)', [
        caseId, dtype, daysFromNow(due), '待处理', note, daysAgoIso(10),
      ])
    }

    // ---- 费用（含逾期红点）----
    // [caseId, kind, amount, dueInDays, paid]
    const fees = [
      [1, '实质审查费', 2500, -2, false],
      [5, '答复代理费', 3000, -5, false],
      [12, '复审请求费', 1000, -1, false],
      [2, '第3年年费', 900, 25, false],
      [9, '代理费', 5000, 10, false],
      [8, '申请费', 900, -10, true],
      [11, '登记费', 200, -20, true],
    ]
    for (const [caseId, kind, amount, due, paid] of fees) {
      await d.insert('INSERT INTO fees (case_id, kind, amount, due_date, status, paid_at, created_at) VALUES (?,?,?,?,?,?,?)', [
        caseId, kind, amount, daysFromNow(due), paid ? '已缴' : '待缴', paid ? daysAgoIso(Math.abs(due) + 2) : null, daysAgoIso(30),
      ])
    }
  })
  console.log('[seed] 完成：3 家客户 / 7 个账号 / 12 件案件 / 11 条期限 / 7 条费用')
  return true
}
