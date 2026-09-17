<template>
  <div>
    <div v-if="stale" class="offline-banner" style="position: static; border-radius: 8px; margin-bottom: 12px">
      <strong>缓存数据</strong>更新于 {{ fmtDateTime(cachedAt, tz) }}，可能已过期；恢复网络后自动刷新。
    </div>

    <ErrorState v-if="error" :code="errorCode" :message="error" />
    <template v-else-if="dash">
      <p class="small muted" style="margin:0 0 12px">
        期限时刻按代理所时区 <strong>{{ tz }}</strong> 显示（数据 UTC 存储），所内今日 {{ dash.local_today }}。
      </p>

      <!-- KPI -->
      <div class="kpi-grid">
        <div class="card kpi"><div class="label">在办案件</div><div class="num">{{ dash.kpi.active_cases }}</div></div>
        <div class="card kpi warn"><div class="label">待处理官文（30日内/已逾期）</div><div class="num">{{ dash.kpi.pending_deadlines }}</div></div>
        <div class="card kpi warn"><div class="label">7 日内到期</div><div class="num">{{ dash.kpi.due_in_7d }}</div></div>
        <div class="card kpi bad">
          <div class="label"><span class="dot"></span> 缴费逾期</div>
          <div class="num">{{ dash.kpi.overdue_fees }}</div>
          <div class="small muted">合计 {{ fmtMoney(dash.kpi.overdue_fee_amount) }}</div>
        </div>
      </div>

      <div class="grid grid-main-side mt16">
        <div class="card">
          <h3>各客户案件阶段（官文八态）</h3>
          <FunnelBoard :funnels="dash.funnels" />
        </div>

        <div class="card">
          <h3><span class="dot"></span> 缴费逾期</h3>
          <div v-if="dash.overdue_fees.length">
            <div v-for="f in dash.overdue_fees" :key="f.id" class="funnel-row" style="cursor: pointer" @click="$router.push(`/cases/${f.case_id}`)">
              <div class="spread">
                <strong>{{ f.kind }}</strong>
                <span class="chip bad">逾期{{ f.overdue_days }}天</span>
              </div>
              <div class="small muted mt8">{{ f.case_no }} · {{ f.case_title }}</div>
              <div class="small mt8">{{ f.client_name }} · 应缴 {{ fmtMoney(f.amount) }} · 截止 {{ fmtDate(f.due_date) }}</div>
            </div>
          </div>
          <p v-else class="muted">暂无逾期费用 👍</p>
        </div>
      </div>

      <!-- 案件完成度（双口径，与详情/导出一致） -->
      <div class="card mt16">
        <div class="spread">
          <h3 style="margin:0">案件完成度</h3>
          <div class="row">
            <span class="small muted">口径：</span>
            <div class="seg">
              <button :class="{ on: metric === 'documents' }" @click="metric = 'documents'">已归档官文数</button>
              <button :class="{ on: metric === 'stages' }" @click="metric = 'stages'">关键阶段数</button>
            </div>
            <button class="btn sm" @click="exportCsv">导出 CSV（含两口径）</button>
          </div>
        </div>
        <p class="small muted mt8">
          当前排序口径：<strong>{{ metric === 'documents' ? '已归档官文数口径' : '关键阶段数口径' }}</strong>——
          {{ metric === 'documents' ? '已归档官文 ÷ 4 份必经主线官文；多通意见会抬高它。' : '已完成关键阶段 ÷ 5；半截官文不会抬高它。' }}
          两口径在每行动作条中同时给出，数字与案件详情、CSV 导出完全一致。
        </p>
        <table class="rtable mt8">
          <thead>
            <tr><th>案件</th><th>状态</th><th style="min-width:230px">完成度（左官文 / 右阶段）</th><th>官文 {{pct('documents')}}</th><th>阶段 {{pct('stages')}}</th></tr>
          </thead>
          <tbody>
            <tr v-for="x in sortedCompletion" :key="x.case_id" @click="$router.push(`/cases/${x.case_id}`)">
              <td data-label="案件">{{ x.case_no }} · {{ x.case_title }}<div class="small muted">{{ x.client_name }} · {{ x.agent_name || '待指派' }}</div></td>
              <td data-label="状态"><StatusBadge :status="x.case_status" /></td>
              <td data-label="完成度"><CompletionMeter :c="x.completion" /></td>
              <td data-label="官文口径"><strong :class="x.completion.documents.percent >= 100 && x.completion.stages.percent <= 60 ? 'warn-text' : ''">{{ x.completion.documents.percent }}%</strong><div class="small muted">{{ x.completion.documents.done }}/{{ x.completion.documents.total }}</div></td>
              <td data-label="阶段口径"><strong>{{ x.completion.stages.percent }}%</strong><div class="small muted">{{ x.completion.stages.done }}/{{ x.completion.stages.total }}</div></td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 官文期限临近 -->
      <h3 class="section-title">官文期限临近（30 天内 / 已逾期）</h3>
      <div class="card" style="padding: 6px 0">
        <table class="rtable">
          <thead>
            <tr><th>期限 / 口径</th><th>到期日</th><th>倒计时</th><th>案件</th><th>客户</th></tr>
          </thead>
          <tbody>
            <tr v-for="d in dash.deadlines" :key="d.id" @click="$router.push(`/cases/${d.case_id}`)">
              <td data-label="期限 / 口径">
                {{ d.dtype }}<div v-if="d.note" class="small muted">{{ d.note }}</div>
                <div v-if="d.base_type" class="basis-line small">
                  <span class="basis-tag">{{ d.base_type === 'receive' ? '自收到日' : d.base_type === 'dispatch' ? '自发文日' : '指定到期日' }}</span>
                  起算 {{ d.base_date || '—' }} · {{ d.day_basis === 'legal' ? '法定节假日口径' : d.day_basis === 'workday' ? '工作日' : '自然日' }}<span v-if="d.receive_presumed"> · 推定收到</span><span v-if="d.rolled_forward"> · 已顺延</span>
                </div>
              </td>
              <td data-label="到期日">{{ fmtDate(d.due_date) }}</td>
              <td data-label="倒计时"><span class="chip" :class="dday(d.due_date, dash.local_today).cls">{{ dday(d.due_date, dash.local_today).text }}</span></td>
              <td data-label="案件">{{ d.case_no }} · {{ d.case_title }}</td>
              <td data-label="客户">{{ d.client_name }}</td>
            </tr>
            <tr v-if="!dash.deadlines.length"><td class="muted no-label" colspan="5" style="text-align:center">暂无临近官文期限</td></tr>
          </tbody>
        </table>
      </div>
    </template>
    <p v-else class="muted">加载中…</p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { get } from '../api.js'
import { store } from '../store.js'
import { fmtDate, fmtDateTime, fmtMoney, dday } from '../utils.js'
import FunnelBoard from '../components/FunnelBoard.vue'
import ErrorState from '../components/ErrorState.vue'
import CompletionMeter from '../components/CompletionMeter.vue'
import StatusBadge from '../components/StatusBadge.vue'

const dash = ref(null)
const stale = ref(false)
const cachedAt = ref(null)
const error = ref('')
const errorCode = ref('ERROR')
const metric = ref('documents')
const tz = computed(() => dash.value?.timezone || store.settings.timezone)
const pct = (k) => `(${k === 'documents' ? '归档数/4' : '阶段数/5'})`

const sortedCompletion = computed(() => {
  const list = dash.value?.completion || []
  return [...list].sort((a, b) => b.completion[metric.value].percent - a.completion[metric.value].percent)
})

async function load() {
  try {
    const r = await get('/dashboard', { cacheKey: 'dashboard' })
    dash.value = r.data
    stale.value = r.stale
    cachedAt.value = r.cachedAt
  } catch (e) {
    error.value = e.code === 'NETWORK' ? '当前离线且暂无缓存数据，请联网后刷新' : e.message
    errorCode.value = e.code
  }
}

async function exportCsv() {
  try {
    const resp = await fetch('/api/export/cases.csv', { headers: { Authorization: `Bearer ${store.token}` } })
    if (!resp.ok) throw new Error(`导出失败（${resp.status}）`)
    const blob = await resp.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `cases-completion-${dash.value.local_today}.csv`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    store.showToast(e.message, 'error')
  }
}

onMounted(() => {
  load()
  window.addEventListener('pc:synced', load)
})
onUnmounted(() => window.removeEventListener('pc:synced', load))
</script>
