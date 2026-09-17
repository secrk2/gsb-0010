// 官文目录：登记官文时选择类型，驱动两件事——
//   1) target_status：该官文对应的法定阶段跃迁（null 表示过程性官文，不改变案件状态）；
//   2) deadlines：登记后自动派生的答复/办理期限模板（到期日由服务端期限引擎统一推算）。
// 仅登记「官文事实」，状态机禁止的跃迁在服务端再次校验拦截。

export const OA_TYPES = {
  receipt: {
    key: 'receipt',
    label: '受理通知书',
    target: '受理',
    deadlines: [],
  },
  preliminary_pass: {
    key: 'preliminary_pass',
    label: '初审合格通知书（公布）',
    target: '初审',
    deadlines: [],
  },
  enter_examination: {
    key: 'enter_examination',
    label: '进入实质审查阶段通知书',
    target: '实审',
    deadlines: [],
  },
  examination_opinion: {
    key: 'examination_opinion',
    label: '审查意见通知书（实审意见）',
    target: null,
    deadlines: [
      // 第一次审查意见答复期 4 个月，再次审查意见 2 个月（登记时可改）
      { title: '答复审查意见通知书', base_type: 'receive', window_value: 4, window_unit: 'month', day_basis: 'natural' },
    ],
  },
  grant_notice: {
    key: 'grant_notice',
    label: '授权通知书（办理登记手续）',
    target: '授权',
    deadlines: [
      { title: '办理登记手续', base_type: 'receive', window_value: 2, window_unit: 'month', day_basis: 'natural' },
    ],
  },
  rejection: {
    key: 'rejection',
    label: '驳回决定',
    target: '驳回',
    deadlines: [
      { title: '复审请求期限', base_type: 'receive', window_value: 3, window_unit: 'month', day_basis: 'natural' },
    ],
  },
  reexamination_accept: {
    key: 'reexamination_accept',
    label: '复审请求受理通知书',
    target: '复审',
    deadlines: [],
  },
  reexamination_opinion: {
    key: 'reexamination_opinion',
    label: '复审通知书（复审意见）',
    target: null,
    deadlines: [
      { title: '答复复审通知书', base_type: 'receive', window_value: 1, window_unit: 'month', day_basis: 'natural' },
    ],
  },
  reexamination_revoke: {
    key: 'reexamination_revoke',
    label: '复审决定·撤销驳回（回实审）',
    target: '实审',
    deadlines: [],
  },
  reexamination_grant: {
    key: 'reexamination_grant',
    label: '复审决定·改判授权',
    target: '授权',
    deadlines: [
      { title: '办理登记手续（复审改判）', base_type: 'receive', window_value: 2, window_unit: 'month', day_basis: 'natural' },
    ],
  },
  reexamination_reject: {
    key: 'reexamination_reject',
    label: '复审决定·维持驳回',
    target: '驳回',
    deadlines: [],
  },
  invalidation_accept: {
    key: 'invalidation_accept',
    label: '无效宣告请求受理通知书',
    target: '无效',
    deadlines: [
      { title: '无效宣告答复意见陈述', base_type: 'receive', window_value: 1, window_unit: 'month', day_basis: 'natural' },
    ],
  },
  invalidation_valid: {
    key: 'invalidation_valid',
    label: '无效决定·维持专利权有效',
    target: '授权',
    deadlines: [],
  },
  invalidation_void: {
    key: 'invalidation_void',
    label: '无效决定·宣告专利权全部无效',
    target: '驳回',
    deadlines: [],
  },
  other: {
    key: 'other',
    label: '其他官文（不改变状态）',
    target: null,
    deadlines: [],
  },
}

export const OA_TYPE_OPTIONS = Object.values(OA_TYPES).map((t) => ({ key: t.key, label: t.label, target: t.target }))
