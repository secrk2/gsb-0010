<template>
  <div>
    <div v-if="stale" class="offline-banner" style="position: static; border-radius: 8px; margin-bottom: 12px">
      <strong>缓存数据</strong>更新于 {{ fmtDateTime(cachedAt) }}，可能已过期；恢复网络后自动刷新。
    </div>

    <ErrorState v-if="error" :code="errorCode" :message="error" />
    <template v-else-if="dash">
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
        <!-- 各客户待处理漏斗 -->
        <div class="card">
          <h3>各客户待处理漏斗</h3>
          <FunnelBoard :funnels="dash.funnels" />
        </div>

        <!-- 缴费逾期红点 -->
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

      <!-- 官文期限临近 -->
      <h3 class="section-title">官文期限临近（30 天内 / 已逾期）</h3>
      <div class="card" style="padding: 6px 0">
        <table class="rtable">
          <thead>
            <tr><th>期限</th><th>到期日</th><th>倒计时</th><th>案件</th><th>客户</th></tr>
          </thead>
          <tbody>
            <tr v-for="d in dash.deadlines" :key="d.id" @click="$router.push(`/cases/${d.case_id}`)">
              <td data-label="期限">{{ d.dtype }}<div v-if="d.note" class="small muted">{{ d.note }}</div></td>
              <td data-label="到期日">{{ fmtDate(d.due_date) }}</td>
              <td data-label="倒计时"><span class="chip" :class="dday(d.due_date).cls">{{ dday(d.due_date).text }}</span></td>
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
import { ref, onMounted, onUnmounted } from 'vue'
import { get } from '../api.js'
import { fmtDate, fmtDateTime, fmtMoney, dday } from '../utils.js'
import FunnelBoard from '../components/FunnelBoard.vue'
import ErrorState from '../components/ErrorState.vue'

const dash = ref(null)
const stale = ref(false)
const cachedAt = ref(null)
const error = ref('')
const errorCode = ref('ERROR')

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

onMounted(() => {
  load()
  window.addEventListener('pc:synced', load)
})
onUnmounted(() => window.removeEventListener('pc:synced', load))
</script>
