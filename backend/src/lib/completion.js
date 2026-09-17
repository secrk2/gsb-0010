// 案件完成度（两种口径，结果可能相反——半截官文的案件正是如此）。
// 口径必须写在界面上，作战台 / 详情 / 导出三处共用本模块，保证同一案件处处相等。
//
//   documents（已归档官文数口径）：已归档（未撤回）官文总数 / 必经主线官文 4 份。
//     必经主线：受理通知、初审合格（公布）、进入实审、审查结论（授权通知或驳回决定）。
//     多通审查/复审意见、复审受理、无效受理等均为真实归档件，计入分子；
//     因此「实审意见发了好几通、案子却还卡在实审」时，本口径会显得很满——这正是它与阶段口径相反的原因。
//     百分比封顶 100，原始件数同时返回（界面明示，不用封顶值糊弄）。
//
//   stages（关键阶段数口径）：5 个关键里程碑完成数 / 5。
//     受理 → 初审 → 实审 → 审查结论 → 后续程序终结（授权生效 / 复审终局 / 无效终局）。
//     驳回但复审期限未启动、复审、无效均不算「终结」。

export const COMPLETION_LABELS = {
  documents: '已归档官文数口径',
  stages: '关键阶段数口径',
}

export const BACKBONE_TOTAL = 4
export const STAGE_TOTAL = 5

const RANK = { 申请: 0, 受理: 1, 初审: 2, 实审: 3, 复审: 3, 驳回: 4, 无效: 4, 授权: 4 }
const STAGE_OA = { 受理: 'receipt', 初审: 'preliminary_pass', 实审: 'enter_examination' }

/**
 * @param {object} p
 * @param {Array<{oa_type:string, status:string}>} p.officeActions  status: active | withdrawn
 * @param {string} p.caseStatus
 */
export function computeCompletion({ officeActions, caseStatus }) {
  const active = (officeActions || []).filter((o) => o.status !== 'withdrawn')
  const types = new Set(active.map((o) => o.oa_type))
  const rank = RANK[caseStatus] ?? 0

  // ---------- 口径一：已归档官文数 ----------
  const archived = active.length
  const opinionCount = active.filter((o) => ['examination_opinion', 'reexamination_opinion'].includes(o.oa_type)).length
  const documents = {
    percent: Math.min(100, Math.round((archived / BACKBONE_TOTAL) * 100)),
    done: archived,
    total: BACKBONE_TOTAL,
    opinion_count: opinionCount,
    capped: archived > BACKBONE_TOTAL,
  }

  // ---------- 口径二：关键阶段数 ----------
  const labels = []
  let done = 0
  for (const [stage, oaKey] of Object.entries(STAGE_OA)) {
    const reached = types.has(oaKey) || rank >= RANK[stage]
    if (reached) {
      done++
      labels.push(stage)
    }
  }
  const hasConclusion = types.has('grant_notice') || types.has('rejection') || ['授权', '驳回'].includes(caseStatus)
  if (hasConclusion) {
    done++
    labels.push('审查结论')
  }
  // 后续程序终结：
  //  - 授权且无在办无效程序（未登记无效受理，或无效受理后又有授权决定=维持有效）→ 终结
  //  - 驳回且复审走完仍维持（复审受理之后又来驳回决定，当前处于驳回）→ 终结
  //  - 复审改判授权（当前授权）→ 终结；单纯驳回（未提复审）、复审、无效 → 未终结
  const invalidationOpen = types.has('invalidation_accept') && caseStatus !== '授权'
  const reexamAccepted = types.has('reexamination_accept')
  let finalized = false
  if (caseStatus === '授权' && !invalidationOpen) finalized = true
  if (caseStatus === '驳回' && reexamAccepted) finalized = true
  if (finalized) {
    done++
    labels.push('程序终结')
  }
  const stages = { percent: Math.round((done / STAGE_TOTAL) * 100), done, total: STAGE_TOTAL, labels, finalized }

  return { documents, stages }
}
