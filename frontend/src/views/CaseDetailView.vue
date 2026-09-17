<template>
  <div>
    <ErrorState v-if="error" :code="errorCode" :message="error" />
    <template v-else-if="c">
      <div v-if="stale" class="offline-banner" style="position: static; border-radius: 8px; margin-bottom: 12px">
        <strong>缓存数据</strong>更新于 {{ fmtDateTime(cachedAt, tz) }}，可能已过期；请勿据此办理期限。
      </div>

      <!-- 概要 -->
      <div class="card">
        <div class="spread">
          <div>
            <div class="row">
              <h3 style="margin: 0">{{ c.title }}</h3>
              <StatusBadge :status="c.status" />
              <span v-if="c.priority === '高'" class="chip bad">高优先级</span>
            </div>
            <div class="muted small mt8">
              {{ c.case_no }} · {{ c.ctype }} · 代理人：{{ c.agent_name || '待指派' }}
              <span v-if="c.contract_no"> · 合同 {{ c.contract_no }}</span>
              · 时区 {{ tz }}
            </div>
          </div>
          <div style="text-align: right">
            <div class="row" style="justify-content: flex-end">
              <span class="muted small">客户</span>
              <strong>{{ revealedName || c.client_name }}</strong>
              <span v-if="c.client_masked && !revealedName" class="lock">🔒</span>
            </div>
            <button v-if="c.client_masked && !revealedName && c.can_reveal" class="btn sm mt8" @click="showReveal = true">查看全称（留痕）</button>
            <p v-if="revealedName" class="small" style="color: var(--warn); margin: 4px 0 0">已留痕解密展示</p>
          </div>
        </div>

        <!-- 完成度：双口径，口径写在界面 -->
        <div class="mt16">
          <div class="spread">
            <h3 style="margin:0;font-size:14px">案件完成度</h3>
            <span class="small muted">两种口径可能相反，已在作战台/本页/导出保持一致</span>
          </div>
          <CompletionMeter :c="c.completion" class="mt8" />
        </div>

        <div v-if="isFirm()" class="row mt16">
          <button class="btn primary sm" @click="openOa">＋ 登记官文</button>
          <router-link class="btn sm" :to="`/calendar?case=${c.id}`">在日历中查看</router-link>
          <button class="btn sm" title="异常状态更正（正常流程请登记官文）" @click="openTransition('', '')">其他状态更正…</button>
        </div>
      </div>

      <!-- 官文时间线 -->
      <div class="card mt16">
        <div class="spread">
          <h3 style="margin:0">官文（{{ activeOaCount }} 条有效 / {{ c.office_actions.length }} 条登记）</h3>
        </div>

        <!-- 空态一：该案无官文 -->
        <div v-if="!c.office_actions.length" class="inline-empty">
          <div class="empty-icon">📭</div>
          <p class="muted" style="margin-bottom:10px">该案尚无官文。登记受理通知书后案件进入「受理」，答复与办理期限将按官文自动派生。</p>
          <button v-if="isFirm()" class="btn primary sm" @click="openOa">登记第一条官文</button>
        </div>

        <!-- 空态二：官文全部撤回 -->
        <div v-else-if="!activeOaCount" class="inline-empty">
          <div class="empty-icon">↩️</div>
          <p class="muted">全部官文已撤回，派生期限已作废，案件状态恢复为「{{ c.status }}」。撤回原因见各条留痕。</p>
        </div>

        <ul v-else class="oa-timeline">
          <li v-for="o in c.office_actions" :key="o.id" :class="{ withdrawn: o.status === 'withdrawn' }">
            <div class="spread">
              <div class="row">
                <strong>📄 {{ o.oa_type_label }}</strong>
                <span v-if="o.target_status" class="chip blue">案件 → {{ o.target_status }}</span>
                <span v-if="o.status === 'withdrawn'" class="chip warn">已撤回</span>
                <span v-else class="chip ok">有效</span>
                <span v-if="o.doc_no" class="small muted">{{ o.doc_no }}</span>
              </div>
              <div class="row">
                <button v-if="isFirm() && o.status !== 'withdrawn'" class="btn sm danger" @click="askWithdraw(o)">撤回</button>
              </div>
            </div>
            <div class="small muted mt8">
              发文日 <strong>{{ o.dispatch_date }}</strong> ·
              收到日 <strong>{{ o.receive_date || `推定 ${presumed(o.dispatch_date, o.presumed_days)}` }}</strong>
              <span v-if="!o.receive_date" class="chip warn" style="margin-left:4px">推定收到</span>
              · {{ o.created_by_name }} 登记
            </div>
            <div v-if="o.note" class="small mt8">备注：{{ o.note }}</div>
            <div v-if="o.status === 'withdrawn'" class="overdue-reason small mt8">
              撤回原因（{{ o.withdrawn_by_name }} · {{ fmtDateTime(o.withdrawn_at, tz) }}）：{{ o.withdraw_reason }}
            </div>
            <!-- 该官文派生期限 -->
            <table v-if="o.deadlines.length" class="rtable static mt8">
              <tbody>
                <tr v-for="d in o.deadlines" :key="d.id" :class="{ 'row-void': d.voided }">
                  <td style="width:34%">
                    {{ d.dtype }}
                    <div class="basis-line small">{{ basisBrief(d) }}</div>
                  </td>
                  <td>到期 <strong>{{ d.due_date }}</strong>
                    <span v-if="d.rolled_forward" class="small muted">（遇假日顺延）</span>
                  </td>
                  <td>
                    <span v-if="d.voided" class="chip warn">已作废</span>
                    <span v-else-if="d.status === '已完成'" class="chip ok">已完成</span>
                    <span v-else class="chip" :class="dday(d.due_date, c.local_today).cls">{{ dday(d.due_date, c.local_today).text }}</span>
                  </td>
                  <td style="text-align:right">
                    <button v-if="isFirm() && !d.voided && d.status !== '已完成'" class="btn sm" @click="onComplete(d)">办结</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </li>
        </ul>
      </div>

      <div class="grid grid-2 mt16">
        <!-- 其他期限（手工登记） -->
        <div class="card">
          <div class="spread">
            <h3 style="margin: 0">其他期限</h3>
            <button v-if="isFirm()" class="btn sm" @click="showDeadline = true">＋ 添加期限</button>
          </div>
          <table class="rtable static mt8" v-if="manualDeadlines.length">
            <tbody>
              <tr v-for="d in manualDeadlines" :key="d.id">
                <td>
                  {{ d.dtype }}<div v-if="d.note" class="small muted">{{ d.note }}</div>
                  <div v-if="d.base_type" class="basis-line small">{{ basisBrief(d) }}</div>
                </td>
                <td>{{ fmtDate(d.due_date) }}<span v-if="d.rolled_forward" class="small muted"> 顺延</span></td>
                <td>
                  <span v-if="d.status === '已完成'" class="chip ok">已完成</span>
                  <span v-else class="chip" :class="dday(d.due_date, c.local_today).cls">{{ dday(d.due_date, c.local_today).text }}</span>
                </td>
                <td style="text-align:right">
                  <button v-if="isFirm() && d.status !== '已完成'" class="btn sm" @click="onComplete(d)">办结</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">暂无手工期限</p>
        </div>

        <!-- 费用 -->
        <div class="card">
          <div class="spread">
            <h3 style="margin: 0">费用</h3>
            <button v-if="isFirm()" class="btn sm" @click="showFee = true">＋ 添加</button>
          </div>
          <table class="rtable static mt8" v-if="c.fees.length">
            <tbody>
              <tr v-for="f in c.fees" :key="f.id">
                <td><span v-if="f.overdue" class="dot"></span> {{ f.kind }}</td>
                <td>{{ fmtMoney(f.amount) }}</td>
                <td>
                  <span v-if="f.status === '已缴'" class="chip ok">已缴</span>
                  <span v-else-if="f.overdue" class="chip bad">逾期</span>
                  <span v-else class="chip warn">待缴 · {{ fmtDate(f.due_date) }}</span>
                </td>
                <td style="text-align:right">
                  <button v-if="isFirm() && f.status !== '已缴'" class="btn sm" @click="payFee(f)">缴费</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">暂无费用记录</p>
        </div>
      </div>

      <!-- 逾期办结留痕展示 -->
      <div v-if="overdueReasons.length" class="card mt16">
        <h3>逾期办结留痕</h3>
        <div v-for="d in overdueReasons" :key="d.id" class="overdue-reason small" style="margin-bottom:6px">
          {{ d.dtype }}（应于 {{ d.due_date }}，{{ fmtDateTime(d.completed_at, tz) }} 办结）：{{ d.overdue_reason }}
          <span v-if="d.completed_by_name"> · {{ d.completed_by_name }}</span>
        </div>
      </div>

      <!-- 流转记录 -->
      <div class="card mt16">
        <h3>流转记录</h3>
        <ul class="timeline">
          <li v-for="e in c.events" :key="e.id">
            <div class="row">
              <strong>{{ e.action }}</strong>
              <template v-if="e.from_status"><StatusBadge :status="e.from_status" /> → <StatusBadge :status="e.to_status" /></template>
              <template v-else><StatusBadge :status="e.to_status" /></template>
              <span v-if="e.event_source === 'office_action'" class="chip blue small">官文驱动</span>
              <span v-else-if="e.event_source === 'withdraw'" class="chip warn small">官文撤回</span>
            </div>
            <div class="t-meta">{{ e.actor_name }} · {{ fmtDateTime(e.created_at, tz) }}<span v-if="e.reason"> · {{ e.reason }}</span></div>
          </li>
        </ul>
      </div>

      <!-- 登记官文 -->
      <OfficeActionModal
        v-if="showOaModal"
        :options="c.registerable_oa"
        :agents="agents"
        :status="c.status"
        :saving="saving"
        :error="oaError"
        @close="showOaModal = false"
        @submit="submitOa"
      />

      <!-- 撤回官文确认 -->
      <Modal v-if="withdrawTarget" title="撤回官文（留痕）" @close="withdrawTarget = null">
        <p class="small">撤回后：该官文派生的<strong>未完成期限一并作废</strong>；若为状态类官文，案件状态恢复到撤回后有效官文链支撑的状态。操作不可删除，仅可重新登记。</p>
        <div class="field">
          <label>撤回原因 *（至少 2 个字）</label>
          <textarea v-model="withdrawReason" rows="3" placeholder="例如：文号登记错误 / 国局更正发文 / 误登记…"></textarea>
        </div>
        <p v-if="withdrawError" class="small bad-text">{{ withdrawError }}</p>
        <div class="modal-actions">
          <button class="btn" @click="withdrawTarget = null">取消</button>
          <button class="btn danger" :disabled="saving || withdrawReason.trim().length < 2" @click="submitWithdraw">确认撤回并留痕</button>
        </div>
      </Modal>

      <!-- 状态手动更正 -->
      <Modal v-if="showTransition" title="异常状态更正" @close="showTransition = false">
        <div class="field">
          <label>目标状态（当前：{{ c.status }}）</label>
          <select v-model="transitionForm.to">
            <option v-for="s in allStatuses" :key="s" :value="s" :disabled="s === c.status">{{ s }}{{ isAllowed(s) ? '（官文可达）' : '' }}</option>
          </select>
          <p class="small muted" style="margin: 6px 0 0">正常流程请登记官文；跳步/非法跃迁会被状态机拦截并说明原因。</p>
        </div>
        <div v-if="transitionForm.to === '受理'" class="field">
          <label>指派代理人 *</label>
          <select v-model="transitionForm.agent_id">
            <option :value="null" disabled>请选择</option>
            <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
        </div>
        <div class="field"><label>理由</label><textarea v-model="transitionForm.reason" rows="2"></textarea></div>
        <p v-if="transitionError" class="small bad-text">{{ transitionError }}</p>
        <div class="modal-actions">
          <button class="btn" @click="showTransition = false">取消</button>
          <button class="btn primary" :disabled="saving || !transitionForm.to" @click="submitTransition">提交更正</button>
        </div>
      </Modal>

      <!-- 添加期限（口径可选） -->
      <Modal v-if="showDeadline" title="添加期限" @close="showDeadline = false">
        <div class="field"><label>事项 *</label><input v-model="deadlineForm.dtype" placeholder="例如：答复第二次审查意见通知书" /></div>
        <div class="field">
          <label>到期方式 *</label>
          <select v-model="deadlineForm.mode">
            <option value="manual">直接指定到期日</option>
            <option value="compute">按发文/收到日 + 期限推算</option>
          </select>
        </div>
        <div v-if="deadlineForm.mode === 'manual'" class="field">
          <label>到期日 *</label>
          <input v-model="deadlineForm.due_date" type="date" />
        </div>
        <template v-else>
          <div class="grid grid-2">
            <div class="field"><label>发文日 *</label><input v-model="deadlineForm.dispatch_date" type="date" /></div>
            <div class="field"><label>实际收到日（可空=推定）</label><input v-model="deadlineForm.receive_date" type="date" /></div>
          </div>
          <div class="field">
            <label>起算口径 *</label>
            <select v-model="deadlineForm.base_type">
              <option value="receive">自收到日（未填实际收到日按推定）</option>
              <option value="dispatch">自发文日</option>
            </select>
          </div>
          <div class="row">
            <div class="field" style="flex:1"><label>期限长度 *</label><input v-model.number="deadlineForm.window_value" type="number" min="1" /></div>
            <div class="field" style="width:90px"><label>单位</label>
              <select v-model="deadlineForm.window_unit"><option value="day">天</option><option value="month">个月</option></select>
            </div>
            <div class="field" style="flex:1"><label>天数口径 *</label>
              <select v-model="deadlineForm.day_basis">
                <option value="natural">自然日</option>
                <option value="workday">工作日</option>
                <option value="legal">法定节假日口径</option>
              </select>
            </div>
          </div>
          <p class="small warn-text">自收到日且未填实际收到日：推定收到日 = 发文日 + 15 天；到期日遇法定休假日依法顺延。</p>
        </template>
        <div class="field"><label>备注</label><input v-model="deadlineForm.note" /></div>
        <div class="modal-actions">
          <button class="btn" @click="showDeadline = false">取消</button>
          <button class="btn primary" :disabled="saving" @click="addDeadline">添加</button>
        </div>
      </Modal>

      <!-- 添加费用 -->
      <Modal v-if="showFee" title="添加费用" @close="showFee = false">
        <div class="field"><label>费用项目 *</label><input v-model="feeForm.kind" placeholder="例如：实质审查费" /></div>
        <div class="field"><label>金额（元）*</label><input v-model.number="feeForm.amount" type="number" min="0" /></div>
        <div class="field"><label>缴费截止日 *</label><input v-model="feeForm.due_date" type="date" /></div>
        <div class="modal-actions">
          <button class="btn" @click="showFee = false">取消</button>
          <button class="btn primary" :disabled="saving" @click="addFee">添加</button>
        </div>
      </Modal>

      <!-- 逾期办结二次确认 -->
      <OverdueCompleteModal
        v-if="overdueTarget"
        :deadline="overdueTarget"
        :details="c"
        :saving="saving"
        :err="completeError"
        @cancel="overdueTarget = null"
        @confirm="confirmOverdue"
      />

      <RevealModal v-if="showReveal" :client-id="c.client_id" :case-id="c.id" @close="showReveal = false" @revealed="(n) => (revealedName = n)" />
    </template>
    <p v-else class="muted">加载中…</p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { get, mutate } from '../api.js'
import { store, isFirm } from '../store.js'
import { fmtDate, fmtDateTime, fmtMoney, dday, basisText } from '../utils.js'
import Modal from '../components/Modal.vue'
import StatusBadge from '../components/StatusBadge.vue'
import ErrorState from '../components/ErrorState.vue'
import RevealModal from '../components/RevealModal.vue'
import CompletionMeter from '../components/CompletionMeter.vue'
import OfficeActionModal from '../components/OfficeActionModal.vue'
import OverdueCompleteModal from '../components/OverdueCompleteModal.vue'

const route = useRoute()
const id = Number(route.params.id)
const c = ref(null)
const stale = ref(false)
const cachedAt = ref(null)
const error = ref('')
const errorCode = ref('ERROR')
const revealedName = ref('')
const showReveal = ref(false)
const showOaModal = ref(false)
const showTransition = ref(false)
const showDeadline = ref(false)
const showFee = ref(false)
const saving = ref(false)
const agents = ref([])
const oaError = ref('')
const withdrawTarget = ref(null)
const withdrawReason = ref('')
const withdrawError = ref('')
const transitionForm = ref({ to: '', reason: '', agent_id: null })
const transitionError = ref('')
const deadlineForm = ref({ dtype: '', mode: 'manual', due_date: '', dispatch_date: '', receive_date: '', base_type: 'receive', window_value: 30, window_unit: 'day', day_basis: 'natural', note: '' })
const feeForm = ref({ kind: '', amount: null, due_date: '' })
const overdueTarget = ref(null)
const completeError = ref('')

const tz = computed(() => c.value?.timezone || store.settings.timezone)
const allStatuses = ['申请', '受理', '初审', '实审', '授权', '驳回', '复审', '无效']
const activeOaCount = computed(() => (c.value?.office_actions || []).filter((o) => o.status !== 'withdrawn').length)
const manualDeadlines = computed(() => (c.value?.deadlines || []).filter((d) => !d.office_action_id && !d.voided))
const overdueReasons = computed(() => (c.value?.deadlines || []).filter((d) => d.status === '已完成' && d.overdue_reason))
const isAllowed = (s) => c.value?.allowed_transitions?.some((t) => t.to === s)
const presumed = (dispatch, days = 15) => {
  const d = new Date(`${dispatch}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + Number(days || 15))
  return d.toISOString().slice(0, 10)
}
const basisBrief = (d) => (d.base_type ? basisText(d) : '')

async function load() {
  try {
    const r = await get(`/cases/${id}`, { cacheKey: `case:${id}` })
    c.value = r.data
    stale.value = r.stale
    cachedAt.value = r.cachedAt
  } catch (e) {
    error.value = e.message
    errorCode.value = e.code
  }
}

async function ensureAgents() {
  if (!agents.value.length && isFirm()) {
    try { agents.value = (await get('/ops/agents')).data } catch {}
  }
}

async function openOa() {
  await ensureAgents()
  oaError.value = ''
  showOaModal.value = true
}

async function submitOa(payload) {
  if (payload.__error) { oaError.value = payload.__error; return }
  saving.value = true
  oaError.value = ''
  try {
    const r = await mutate('POST', `/cases/${id}/office-actions`, payload, {
      offlineOp: { op: 'oa.register', payload: { case_id: id, ...payload }, label: `登记官文「${payload.oa_type}」` },
    })
    if (r.queued) store.showToast('当前离线：官文已加入待同步队列', 'info')
    else store.showToast('官文已登记，案件状态与期限已更新', 'success')
    showOaModal.value = false
    await load()
  } catch (e) {
    oaError.value = e.message
  } finally {
    saving.value = false
  }
}

function askWithdraw(o) {
  withdrawTarget.value = o
  withdrawReason.value = ''
  withdrawError.value = ''
}

async function submitWithdraw() {
  saving.value = true
  withdrawError.value = ''
  try {
    const r = await mutate('POST', `/cases/${id}/office-actions/${withdrawTarget.value.id}/withdraw`, { reason: withdrawReason.value }, {
      offlineOp: { op: 'oa.withdraw', payload: { id: withdrawTarget.value.id, reason: withdrawReason.value }, label: `撤回官文「${withdrawTarget.value.oa_type_label}」` },
    })
    if (r.queued) store.showToast('当前离线：撤回已加入待同步队列', 'info')
    else store.showToast(`官文已撤回，案件状态恢复为「${r.data?.reverted_to || ''}」`, 'success')
    withdrawTarget.value = null
    await load()
  } catch (e) {
    withdrawError.value = e.message
  } finally {
    saving.value = false
  }
}

async function openTransition(to) {
  transitionError.value = ''
  transitionForm.value = { to: to || allStatuses.find((s) => isAllowed(s)) || '', reason: '', agent_id: null }
  await ensureAgents()
  showTransition.value = true
}

async function submitTransition() {
  saving.value = true
  transitionError.value = ''
  const body = { to: transitionForm.value.to, reason: transitionForm.value.reason, agent_id: transitionForm.value.agent_id }
  try {
    const r = await mutate('POST', `/cases/${id}/transition`, body, {
      offlineOp: { op: 'case.transition', payload: { case_id: id, ...body }, label: `案件 ${c.value.case_no} 更正为「${body.to}」` },
    })
    if (r.queued) store.showToast('当前离线：状态更正已加入待同步队列', 'info')
    else store.showToast('状态已更正', 'success')
    showTransition.value = false
    await load()
  } catch (e) {
    transitionError.value = e.message
  } finally {
    saving.value = false
  }
}

function onComplete(d) {
  if (d.overdue || d.due_date < c.value?.local_today) {
    overdueTarget.value = d
    completeError.value = ''
  } else {
    directComplete(d)
  }
}

async function directComplete(d, reason = '') {
  saving.value = true
  try {
    const body = reason ? { confirmed: true, reason } : undefined
    const r = await mutate('POST', `/ops/deadlines/${d.id}/complete`, body, {
      offlineOp: { op: 'deadline.complete', payload: { id: d.id, reason }, label: `办结「${d.dtype}」` },
    })
    if (r.queued) store.showToast('当前离线：办结已加入待同步队列', 'info')
    else store.showToast(reason ? '已逾期办结，原因已留痕' : '期限已办结', reason ? 'error' : 'success')
    await load()
  } catch (e) {
    if (e.code === 'NEED_OVERDUE_REASON') {
      overdueTarget.value = d
      completeError.value = ''
    } else {
      store.showToast(e.message, 'error')
    }
  } finally {
    saving.value = false
  }
}

async function confirmOverdue(reason) {
  const d = overdueTarget.value
  overdueTarget.value = null
  await directComplete(d, reason)
}

async function payFee(f) {
  try {
    const r = await mutate('POST', `/ops/fees/${f.id}/pay`, undefined, {
      offlineOp: { op: 'fee.pay', payload: { id: f.id }, label: `缴纳「${f.kind}」` },
    })
    store.showToast(r.queued ? '已加入待同步队列' : '已登记缴费', r.queued ? 'info' : 'success')
    if (!r.queued) await load()
  } catch (e) {
    store.showToast(e.message, 'error')
  }
}

async function addDeadline() {
  const f = deadlineForm.value
  if (!f.dtype) return
  if (f.mode === 'manual' && !f.due_date) { store.showToast('请指定到期日', 'error'); return }
  if (f.mode === 'compute' && (!f.dispatch_date || !f.window_value)) { store.showToast('请补全发文日与期限长度', 'error'); return }
  saving.value = true
  try {
    const body = f.mode === 'manual'
      ? { dtype: f.dtype, due_date: f.due_date, note: f.note }
      : { dtype: f.dtype, dispatch_date: f.dispatch_date, receive_date: f.receive_date || null, base_type: f.base_type, window_value: f.window_value, window_unit: f.window_unit, day_basis: f.day_basis, note: f.note }
    const r = await mutate('POST', `/cases/${id}/deadlines`, body, {
      offlineOp: { op: 'deadline.create', payload: { case_id: id, ...body }, label: `添加期限「${body.dtype}」` },
    })
    if (r.queued) store.showToast('当前离线：期限已加入待同步队列', 'info')
    else await load()
    showDeadline.value = false
    deadlineForm.value = { dtype: '', mode: 'manual', due_date: '', dispatch_date: '', receive_date: '', base_type: 'receive', window_value: 30, window_unit: 'day', day_basis: 'natural', note: '' }
    store.showToast('期限已添加（到期日由系统按口径推算）', 'success')
    await load()
  } catch (e) {
    store.showToast(e.message, 'error')
  } finally {
    saving.value = false
  }
}

function addFee() {
  if (!feeForm.value.kind || feeForm.value.amount == null || !feeForm.value.due_date) return
  saving.value = true
  mutate('POST', `/cases/${id}/fees`, feeForm.value)
    .then(() => { showFee.value = false; feeForm.value = { kind: '', amount: null, due_date: '' }; return load() })
    .catch((e) => store.showToast(e.message, 'error'))
    .finally(() => (saving.value = false))
}

onMounted(() => {
  load()
  window.addEventListener('pc:synced', load)
})
onUnmounted(() => window.removeEventListener('pc:synced', load))
</script>

<style scoped>
.oa-timeline { list-style: none; margin: 12px 0 0; padding: 0; }
.oa-timeline li { border: 1px solid var(--line); border-radius: 8px; padding: 11px 13px; margin-bottom: 10px; }
.oa-timeline li.withdrawn { background: #fcfbf7; opacity: 0.92; }
.row-void td { text-decoration: line-through; color: var(--muted); }
.inline-empty { text-align: center; padding: 28px 16px; }
.inline-empty .empty-icon { font-size: 32px; }
</style>
