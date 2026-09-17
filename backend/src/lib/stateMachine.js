// 案件状态机：官文驱动案件在八个法定阶段间流转。
// 该模块为纯函数，路由、官文服务与离线合并（sync）共用同一套校验。
//
// 设计原则：
//   - 只允许「官文事实」支撑的跃迁，边采用显式白名单（禁跳步、禁非法跃迁）；
//   - 状态允许来回：驳回 ↔ 复审、授权 ↔ 无效、复审 → 实审（撤销驳回复审）均为合法边；
//   - 同状态重放为幂等空操作；
//   - 每条边声明可登记角色与前置条件。

export const STATUSES = ['申请', '受理', '初审', '实审', '授权', '驳回', '复审', '无效']

const ROLE_NAMES = { admin: '管理员', agent: '代理人', reviewer: '审核员', client_admin: '客户管理员' }

// from -> to -> { label, roles, requires, oa }
// oa：允许驱动该条边的官文类型。同一目标状态可能来自不同程序（实审/复审/无效都可能到授权/驳回），
// 必须用官文类型区分，禁止用「复审改判授权」从实审直接授权这类绕过程序的跃迁。
const FLOW = {
  申请: {
    受理: { label: '受理通知登记', roles: ['admin'], requires: ['contract', 'agent'], oa: ['receipt'] },
  },
  受理: {
    初审: { label: '初审合格/公布登记', roles: ['admin', 'agent', 'reviewer'], oa: ['preliminary_pass'] },
  },
  初审: {
    实审: { label: '进入实质审查登记', roles: ['admin', 'agent', 'reviewer'], oa: ['enter_examination'] },
  },
  实审: {
    授权: { label: '授权办登登记', roles: ['admin', 'reviewer'], oa: ['grant_notice'] },
    驳回: { label: '驳回决定登记', roles: ['admin', 'reviewer'], oa: ['rejection'] },
  },
  驳回: {
    // 驳回决定后 3 个月内提复审；复审请求被受理 → 复审（合法的「回退/复活」路径）
    复审: { label: '复审受理登记', roles: ['admin', 'agent', 'reviewer'], oa: ['reexamination_accept'] },
  },
  复审: {
    实审: { label: '复审撤销驳回·回实审', roles: ['admin', 'reviewer'], oa: ['reexamination_revoke'] },
    授权: { label: '复审改判授权登记', roles: ['admin', 'reviewer'], oa: ['reexamination_grant'] },
    驳回: { label: '复审维持驳回登记', roles: ['admin', 'reviewer'], oa: ['reexamination_reject'] },
  },
  授权: {
    无效: { label: '无效宣告受理登记', roles: ['admin', 'reviewer'], oa: ['invalidation_accept'] },
  },
  无效: {
    授权: { label: '无效决定·维持有效', roles: ['admin', 'reviewer'], oa: ['invalidation_valid'] },
    驳回: { label: '无效决定·宣告无效', roles: ['admin', 'reviewer'], oa: ['invalidation_void'] },
  },
}

// 过程性官文（target=null）只允许在对应程序阶段登记；other 不限阶段。
export const OA_STAGE_SCOPE = {
  examination_opinion: ['实审'],
  reexamination_opinion: ['复审'],
}

// 官文在当前阶段是否可登记（前端按钮与服务端登记共用，杜绝绕过程序的跃迁）
export function isOaAllowedAtStage(oaType, target, fromStatus, role, isAssignee) {
  if (target === null) {
    const scope = OA_STAGE_SCOPE[oaType]
    if (scope && !scope.includes(fromStatus)) return false
    if (!['admin', 'agent', 'reviewer'].includes(role)) return false
    if (role === 'agent' && !isAssignee) return false
    return true
  }
  const spec = (FLOW[fromStatus] || {})[target]
  return Boolean(spec && spec.oa.includes(oaType) && spec.roles.includes(role) && (role !== 'agent' || isAssignee))
}

// 仅用于错误归类（「回退」还是「跳级」），不用于授权——合法的来回边已在 FLOW 中。
const RANK = { 申请: 0, 受理: 1, 初审: 2, 实审: 3, 复审: 4, 授权: 5, 驳回: 5, 无效: 6 }

export function allowedTargets(from) {
  return Object.keys(FLOW[from] || {})
}

// 取一条状态边的完整定义（含允许的官文类型 oa）
export function edgeSpec(from, to) {
  return (FLOW[from] || {})[to] || null
}

// 返回当前用户在某案件上可执行的流转动作（前端按此渲染按钮）
export function allowedTransitionsFor(status, role, isAssignee) {
  return Object.entries(FLOW[status] || {})
    .filter(([, spec]) => spec.roles.includes(role) && (role !== 'agent' || isAssignee))
    .map(([to, spec]) => ({ to, label: spec.label }))
}

/**
 * 校验一次状态流转。
 * @returns {ok:true, noop?:bool, label?:string} | {ok:false, http, code, message}
 */
export function checkTransition({ from, to, role, isAssignee, hasContract, hasAgent }) {
  if (!STATUSES.includes(to)) {
    return { ok: false, http: 400, code: 'BAD_STATUS', message: `未知状态「${to}」` }
  }
  // 幂等：目标状态即当前状态 → 视为成功空操作（离线重试/双击安全）
  if (from === to) {
    return { ok: true, noop: true }
  }
  const spec = (FLOW[from] || {})[to]
  if (!spec) {
    const isRollback = (RANK[to] ?? -1) < (RANK[from] ?? -1)
    if (isRollback) {
      return {
        ok: false,
        http: 409,
        code: 'ILLEGAL_ROLLBACK',
        message: `非法跃迁：案件当前处于「${from}」，不能直接回退到「${to}」。状态可在官文支撑下合法来回（如驳回→复审、授权→无效），但该回退没有对应的法定程序或官文；如确需更正，请报管理员走异常处理流程。`,
      }
    }
    const next = allowedTargets(from)
    return {
      ok: false,
      http: 409,
      code: 'ILLEGAL_TRANSITION',
      message: `非法跃迁：不能从「${from}」直接变更为「${to}」，禁止跳步。${next.length ? `登记对应官文后可执行的下一步：${next.map((t) => `「${t}」`).join('、')}。` : '该案件当前没有可继续的法定流转（终态）。'}`
      ,
    }
  }
  if (!spec.roles.includes(role)) {
    const need = spec.roles.map((r) => ROLE_NAMES[r]).join('或')
    return { ok: false, http: 403, code: 'ROLE_DENIED', message: `当前角色（${ROLE_NAMES[role] || role}）无权执行「${spec.label}」，该操作需${need}处理。` }
  }
  if (role === 'agent' && !isAssignee) {
    return { ok: false, http: 403, code: 'NOT_ASSIGNEE', message: '代理人只能操作自己名下的案件。' }
  }
  if (spec.requires?.includes('contract') && !hasContract) {
    return { ok: false, http: 409, code: 'NO_CONTRACT', message: '该客户尚未签署委托合同，不能受理立项。请先在「委托与客户」中完成合同签订。' }
  }
  if (spec.requires?.includes('agent') && !hasAgent) {
    return { ok: false, http: 409, code: 'NO_AGENT', message: '受理立项时必须指定承办代理人。' }
  }
  return { ok: true, label: spec.label }
}
