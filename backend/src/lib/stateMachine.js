// 案件状态机：专利流程依法定程序单向推进，非法回退/跳级在此统一拦截并说明原因。
// 该模块为纯函数，路由与离线合并（sync）共用同一套校验。

export const STATUSES = ['委托中', '已立项', '实审中', '复审中', '授权', '驳回']

const ROLE_NAMES = { admin: '管理员', agent: '代理人', reviewer: '审核员', client_admin: '客户管理员' }

// from -> to -> { label, roles, requires }
const FLOW = {
  委托中: {
    已立项: { label: '立项', roles: ['admin'], requires: ['contract', 'agent'] },
  },
  已立项: {
    实审中: { label: '提交实审', roles: ['admin', 'agent', 'reviewer'] },
  },
  实审中: {
    授权: { label: '授权登记', roles: ['admin', 'reviewer'] },
    驳回: { label: '驳回登记', roles: ['admin', 'reviewer'] },
  },
  驳回: {
    复审中: { label: '提起复审', roles: ['admin', 'agent', 'reviewer'] },
  },
  复审中: {
    授权: { label: '复审改判授权', roles: ['admin', 'reviewer'] },
    驳回: { label: '维持驳回', roles: ['admin', 'reviewer'] },
  },
}

// 用于判断「回退」还是「跳级」的阶段序号（授权/驳回为终态并列）
const RANK = { 委托中: 0, 已立项: 1, 实审中: 2, 复审中: 3, 授权: 4, 驳回: 4 }

export function allowedTargets(from) {
  return Object.keys(FLOW[from] || {})
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
    const isRollback = RANK[to] < RANK[from]
    if (isRollback) {
      return {
        ok: false,
        http: 409,
        code: 'ILLEGAL_ROLLBACK',
        message: `非法回退：案件当前处于「${from}」，不能回退到「${to}」。专利审查流程依法定程序单向推进，已完成的阶段不可重置；如确需更正，请报管理员走异常处理流程。`,
      }
    }
    const next = allowedTargets(from)
    return {
      ok: false,
      http: 409,
      code: 'ILLEGAL_TRANSITION',
      message: `非法流转：不能从「${from}」直接变更为「${to}」。${next.length ? `当前可执行的下一步：${next.map((t) => `「${t}」`).join('、')}。` : '该案件已处于终态，不可再流转。'}`,
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
    return { ok: false, http: 409, code: 'NO_CONTRACT', message: '该客户尚未签署委托合同，不能立项。请先在「委托与客户」中完成合同签订。' }
  }
  if (spec.requires?.includes('agent') && !hasAgent) {
    return { ok: false, http: 409, code: 'NO_AGENT', message: '立项时必须指定承办代理人。' }
  }
  return { ok: true, label: spec.label }
}
