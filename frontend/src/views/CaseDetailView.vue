<template>
  <div>
    <ErrorState v-if="error" :code="errorCode" :message="error" />
    <template v-else-if="c">
      <div v-if="stale" class="offline-banner" style="position: static; border-radius: 8px; margin-bottom: 12px">
        <strong>缓存数据</strong>更新于 {{ fmtDateTime(cachedAt) }}，可能已过期；请勿据此办理期限。
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
            </div>
          </div>
          <div style="text-align: right">
            <div class="row" style="justify-content: flex-end">
              <span class="muted small">客户</span>
              <strong>{{ revealedName || c.client_name }}</strong>
              <span v-if="c.client_masked && !revealedName" class="lock">🔒</span>
            </div>
            <button
              v-if="c.client_masked && !revealedName && c.can_reveal"
              class="btn sm mt8"
              @click="showReveal = true"
            >查看全称（留痕）</button>
            <p v-if="revealedName" class="small" style="color: var(--warn); margin: 4px 0 0">已留痕解密展示</p>
          </div>
        </div>
        <div v-if="isFirm() && c.allowed_transitions.length" class="row mt16">
          <span class="small muted">可执行：</span>
          <button
            v-for="t in c.allowed_transitions"
            :key="t.to"
            class="btn primary sm"
            @click="openTransition(t.to, t.label)"
          >{{ t.label }} → {{ t.to }}</button>
          <button class="btn sm" title="尝试其他状态变更（非法操作将被状态机拦截并说明原因）" @click="openTransition('', '')">其他状态…</button>
        </div>
      </div>

      <div class="grid grid-2 mt16">
        <!-- 官文期限 -->
        <div class="card">
          <div class="spread">
            <h3 style="margin: 0">官文期限</h3>
            <button v-if="isFirm()" class="btn sm" @click="showDeadline = true">＋ 添加</button>
          </div>
          <table class="rtable static mt8" v-if="c.deadlines.length">
            <tbody>
              <tr v-for="d in c.deadlines" :key="d.id">
                <td data-label="事项">{{ d.dtype }}<div v-if="d.note" class="small muted">{{ d.note }}</div></td>
                <td data-label="到期">{{ fmtDate(d.due_date) }}</td>
                <td data-label="状态">
                  <span v-if="d.status === '已完成'" class="chip ok">已完成</span>
                  <span v-else class="chip" :class="dday(d.due_date).cls">{{ dday(d.due_date).text }}</span>
                </td>
                <td class="no-label" style="text-align: right">
                  <button v-if="isFirm() && d.status !== '已完成'" class="btn sm" @click="completeDeadline(d)">完成</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">暂无官文期限</p>
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
                <td data-label="费用"><span v-if="f.overdue" class="dot"></span> {{ f.kind }}</td>
                <td data-label="金额">{{ fmtMoney(f.amount) }}</td>
                <td data-label="状态">
                  <span v-if="f.status === '已缴'" class="chip ok">已缴</span>
                  <span v-else-if="f.overdue" class="chip bad">逾期</span>
                  <span v-else class="chip warn">待缴 · {{ fmtDate(f.due_date) }}</span>
                </td>
                <td class="no-label" style="text-align: right">
                  <button v-if="isFirm() && f.status !== '已缴'" class="btn sm" @click="payFee(f)">缴费</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">暂无费用记录</p>
        </div>
      </div>

      <!-- 流转记录 -->
      <div class="card">
        <h3>流转记录</h3>
        <ul class="timeline">
          <li v-for="e in c.events" :key="e.id">
            <div class="row">
              <strong>{{ e.action }}</strong>
              <template v-if="e.from_status"><StatusBadge :status="e.from_status" /> → <StatusBadge :status="e.to_status" /></template>
              <template v-else><StatusBadge :status="e.to_status" /></template>
            </div>
            <div class="t-meta">{{ e.actor_name }} · {{ fmtDateTime(e.created_at) }}<span v-if="e.reason"> · {{ e.reason }}</span></div>
          </li>
        </ul>
      </div>

      <!-- 状态流转弹窗 -->
      <Modal v-if="showTransition" title="变更案件状态" @close="showTransition = false">
        <div class="field">
          <label>目标状态（当前：{{ c.status }}）</label>
          <select v-model="transitionForm.to">
            <option v-for="s in allStatuses" :key="s" :value="s" :disabled="s === c.status">
              {{ s }}{{ isAllowed(s) ? '（可执行）' : '' }}
            </option>
          </select>
          <p class="small muted" style="margin: 6px 0 0">非法回退/跳级将被状态机拦截并说明原因。</p>
        </div>
        <div v-if="transitionForm.to === '已立项'" class="field">
          <label>指派代理人 *</label>
          <select v-model="transitionForm.agent_id">
            <option :value="null" disabled>请选择</option>
            <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
        </div>
        <div class="field">
          <label>备注/理由</label>
          <textarea v-model="transitionForm.reason" rows="2" placeholder="将写入流转记录"></textarea>
        </div>
        <p v-if="transitionError" class="small" style="color: var(--bad)">{{ transitionError }}</p>
        <div class="modal-actions">
          <button class="btn" @click="showTransition = false">取消</button>
          <button class="btn primary" :disabled="saving || !transitionForm.to" @click="submitTransition">提交</button>
        </div>
      </Modal>

      <!-- 添加期限 -->
      <Modal v-if="showDeadline" title="添加官文期限" @close="showDeadline = false">
        <div class="field"><label>事项 *</label><input v-model="deadlineForm.dtype" placeholder="例如：答复第二次审查意见通知书" /></div>
        <div class="field"><label>到期日 *</label><input v-model="deadlineForm.due_date" type="date" /></div>
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

      <RevealModal
        v-if="showReveal"
        :client-id="c.client_id"
        :case-id="c.id"
        @close="showReveal = false"
        @revealed="(n) => (revealedName = n)"
      />
    </template>
    <p v-else class="muted">加载中…</p>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { get, mutate } from '../api.js'
import { store, isFirm } from '../store.js'
import { fmtDate, fmtDateTime, fmtMoney, dday } from '../utils.js'
import Modal from '../components/Modal.vue'
import StatusBadge from '../components/StatusBadge.vue'
import ErrorState from '../components/ErrorState.vue'
import RevealModal from '../components/RevealModal.vue'

const route = useRoute()
const id = Number(route.params.id)
const c = ref(null)
const stale = ref(false)
const cachedAt = ref(null)
const error = ref('')
const errorCode = ref('ERROR')
const revealedName = ref('')
const showReveal = ref(false)
const showTransition = ref(false)
const showDeadline = ref(false)
const showFee = ref(false)
const saving = ref(false)
const agents = ref([])
const allStatuses = ['委托中', '已立项', '实审中', '复审中', '授权', '驳回']
const transitionForm = ref({ to: '', reason: '', agent_id: null })
const transitionError = ref('')
const deadlineForm = ref({ dtype: '', due_date: '', note: '' })
const feeForm = ref({ kind: '', amount: null, due_date: '' })

const isAllowed = (s) => c.value?.allowed_transitions?.some((t) => t.to === s)

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

async function openTransition(to, label) {
  transitionError.value = ''
  transitionForm.value = { to: to || allStatuses.find((s) => isAllowed(s)) || '', reason: '', agent_id: null }
  if (!agents.value.length && isFirm()) {
    try {
      agents.value = (await get('/ops/agents')).data
    } catch {}
  }
  showTransition.value = true
}

async function submitTransition() {
  saving.value = true
  transitionError.value = ''
  const body = {
    to: transitionForm.value.to,
    reason: transitionForm.value.reason,
    agent_id: transitionForm.value.agent_id,
  }
  try {
    const r = await mutate('POST', `/cases/${id}/transition`, body, {
      offlineOp: { op: 'case.transition', payload: { case_id: id, ...body }, label: `案件 ${c.value.case_no} 变更为「${body.to}」` },
    })
    showTransition.value = false
    if (r.queued) {
      store.showToast('当前离线：状态变更已加入待同步队列', 'info')
    } else {
      store.showToast('状态已更新', 'success')
      await load()
    }
  } catch (e) {
    // 非法回退/跳级/越权：展示服务端给出的具体原因
    transitionError.value = e.message
  } finally {
    saving.value = false
  }
}

async function completeDeadline(d) {
  try {
    const r = await mutate('POST', `/ops/deadlines/${d.id}/complete`, undefined, {
      offlineOp: { op: 'deadline.complete', payload: { id: d.id }, label: `完成期限「${d.dtype}」` },
    })
    store.showToast(r.queued ? '已加入待同步队列' : '期限已标记完成', r.queued ? 'info' : 'success')
    if (!r.queued) await load()
  } catch (e) {
    store.showToast(e.message, 'error')
  }
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
  if (!deadlineForm.value.dtype || !deadlineForm.value.due_date) return
  saving.value = true
  try {
    await mutate('POST', `/cases/${id}/deadlines`, deadlineForm.value)
    showDeadline.value = false
    deadlineForm.value = { dtype: '', due_date: '', note: '' }
    await load()
  } catch (e) {
    store.showToast(e.message, 'error')
  } finally {
    saving.value = false
  }
}

async function addFee() {
  if (!feeForm.value.kind || feeForm.value.amount == null || !feeForm.value.due_date) return
  saving.value = true
  try {
    await mutate('POST', `/cases/${id}/fees`, feeForm.value)
    showFee.value = false
    feeForm.value = { kind: '', amount: null, due_date: '' }
    await load()
  } catch (e) {
    store.showToast(e.message, 'error')
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  load()
  window.addEventListener('pc:synced', load)
})
onUnmounted(() => window.removeEventListener('pc:synced', load))
</script>
