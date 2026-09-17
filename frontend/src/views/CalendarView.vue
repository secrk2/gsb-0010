<template>
  <div>
    <div class="spread">
      <h2 style="margin:0">官文与期限</h2>
      <div class="row">
        <select v-model="caseFilter" class="case-select" @change="reload">
          <option value="">全部案件</option>
          <option v-for="c in caseOptions" :key="c.id" :value="c.id">{{ c.case_no }} · {{ c.title }}</option>
        </select>
      </div>
    </div>

    <!-- 口径与时区声明（不让代理人猜） -->
    <div class="cal-meta card">
      <div class="row" style="gap:14px">
        <div class="seg">
          <button :class="{ on: view === 'month' }" @click="setView('month')">月视图</button>
          <button :class="{ on: view === 'week' }" @click="setView('week')">周视图</button>
        </div>
        <button class="btn sm" @click="shift(-1)">‹ 上{{ view === 'month' ? '月' : '周' }}</button>
        <strong class="range-title">{{ range.title }}</strong>
        <button class="btn sm" @click="shift(1)">下{{ view === 'month' ? '月' : '周' }} ›</button>
        <button class="btn sm" @click="goToday">今天</button>
      </div>
      <p class="small muted" style="margin:8px 0 0">
        期限按 UTC 存储，依代理所时区 <strong>{{ tz }}</strong> 显示当地日期（今日 {{ data?.today || '…' }}）；
        起算口径分「自收到日 / 自发文日」，天数口径分「自然日 / 工作日 / 法定节假日」，每张期限卡均标明。
      </p>
    </div>

    <div v-if="stale" class="offline-banner" style="position:static;border-radius:8px;margin:12px 0">
      <strong>缓存数据</strong>更新于 {{ fmtDateTime(cachedAt, tz) }}，可能已过期；请勿据此办理期限。
    </div>

    <!-- 错误态 -->
    <ErrorState v-if="error" :code="errorCode" :message="error" />

    <template v-else-if="data">
      <!-- 空态一：该案无官文 -->
      <div v-if="caseEmpty === 'no_oa'" class="card empty-card">
        <div class="empty-icon">📭</div>
        <h3>该案尚无官文</h3>
        <p class="muted">案件 <strong>{{ caseTitle }}</strong> 还未登记任何官文（受理、审查意见、授权办登等）。<br/>请进入案件详情登记第一条官文，状态与法定期限将随官文自动生成。</p>
        <router-link class="btn primary" :to="`/cases/${caseFilter}`">前往案件详情登记</router-link>
      </div>

      <!-- 空态二：官文全部撤回 -->
      <div v-else-if="caseEmpty === 'all_withdrawn'" class="card empty-card">
        <div class="empty-icon">↩️</div>
        <h3>该案官文已全部撤回</h3>
        <p class="muted">案件 <strong>{{ caseTitle }}</strong> 的 {{ withdrawnCount }} 条官文均已撤回，其派生期限已随官文作废，案件状态恢复为「{{ withdrawnCaseStatus }}」。</p>
        <div v-if="withdrawnReasons.length" class="withdrawn-list">
          <div v-for="w in withdrawnReasons" :key="w.id" class="small">
            <span class="chip warn">已撤回</span> {{ w.oa_type_label }}（发文 {{ w.dispatch_date }}）
            <div class="muted">原因：{{ w.withdraw_reason }} · {{ w.withdrawn_by_name }} {{ fmtDateTime(w.withdrawn_at, tz) }}</div>
          </div>
        </div>
        <router-link class="btn" :to="`/cases/${caseFilter}`">查看案件留痕</router-link>
      </div>

      <!-- 空态三：区间无落点（区别于加载错误） -->
      <div v-else-if="!hasAnyItem" class="card empty-card">
        <div class="empty-icon">🗓️</div>
        <h3>{{ range.title }} 没有官文或期限落点</h3>
        <p class="muted">{{ caseFilter ? '该案在本时段内无到期期限、也无发文落点。' : '全所在本时段内无到期期限、也无官文发文落点。' }}可切换月/周或跳转其他时段。</p>
      </div>

      <!-- 正常日历（三套布局各出一版，按断点由 CSS 切换） -->
      <template v-else>
        <!-- 桌面：全宽月历/周历网格 -->
        <div class="cal-desktop card mt16">
          <div class="cal-grid" :class="{ week: view === 'week' }">
            <div v-for="w in WEEKDAY_LABELS" :key="w" class="cal-dow">{{ '周' + w }}</div>
            <div
              v-for="day in range.days"
              :key="day"
              class="cal-cell"
              :class="{ muted: !inMonth(day), today: day === data.today, selected: day === selectedDay }"
              @click="selectedDay = day"
            >
              <div class="cal-dnum">{{ Number(day.slice(8)) }}</div>
              <div class="cal-items">
                <div v-for="d in byDate(day).deadlines" :key="'d'+d.id" class="cal-chip dl" :class="dClass(d)" @click.stop="openCase(d.case_id)">
                  <span class="t-dot"></span>{{ d.dtype }}
                </div>
                <div v-for="o in byDate(day).oas" :key="'o'+o.id" class="cal-chip oa" @click.stop="openCase(o.case_id)">
                  📄 {{ o.oa_type_label }}
                </div>
              </div>
            </div>
          </div>
          <div v-if="selectedItems.length" class="day-detail">
            <h3 style="margin:12px 0 6px">{{ selectedDay }} 当日事项（{{ selectedItems.length }}）</h3>
            <DeadlineList :items="selectedItems" :tz="tz" :today="data.today" @complete="onComplete" @open="openCase" />
          </div>
        </div>

        <!-- 平板：左日历 + 右事项两栏 -->
        <div class="cal-tablet mt16">
          <div class="card">
            <div class="cal-grid mini" :class="{ week: view === 'week' }">
              <div v-for="w in WEEKDAY_LABELS" :key="w" class="cal-dow">{{ '周' + w }}</div>
              <div
                v-for="day in range.days"
                :key="day"
                class="cal-cell"
                :class="{ muted: !inMonth(day), today: day === data.today, selected: day === selectedDay, marked: byDate(day).deadlines.length || byDate(day).oas.length }"
                @click="selectedDay = day"
              >
                <div class="cal-dnum">{{ Number(day.slice(8)) }}</div>
                <span v-if="byDate(day).deadlines.length" class="cal-badge">{{ byDate(day).deadlines.length }}</span>
              </div>
            </div>
          </div>
          <div class="card">
            <h3>{{ selectedDay }} 事项</h3>
            <DeadlineList v-if="selectedItems.length" :items="selectedItems" :tz="tz" :today="data.today" @complete="onComplete" @open="openCase" />
            <p v-else class="muted">当日无事项，点选有标记的日期查看。</p>
          </div>
        </div>

        <!-- 手机：竖向事项流 -->
        <div class="cal-phone mt16">
          <div v-for="day in range.days.filter((d) => byDate(d).deadlines.length || byDate(d).oas.length)" :key="day" class="card day-card">
            <div class="spread">
              <strong>{{ day }} {{ weekdayName(day) }}</strong>
              <span v-if="day === data.today" class="chip blue">今天</span>
            </div>
            <DeadlineList :items="byDate(day).all" :tz="tz" :today="data.today" @complete="onComplete" @open="openCase" />
          </div>
        </div>
      </template>
    </template>

    <!-- 逾期办结二次确认 -->
    <OverdueCompleteModal
      v-if="overdueTarget"
      :deadline="overdueTarget"
      :details="data"
      :saving="saving"
      :err="completeError"
      @cancel="overdueTarget = null"
      @confirm="confirmOverdue"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { get, mutate } from '../api.js'
import { store } from '../store.js'
import { fmtDateTime, dday, basisText, monthGrid, weekRange, shiftMonth, shiftWeek, WEEKDAY_LABELS } from '../utils.js'
import ErrorState from '../components/ErrorState.vue'
import OverdueCompleteModal from '../components/OverdueCompleteModal.vue'
import DeadlineList from '../components/DeadlineList.vue'

const router = useRouter()
const route = useRoute()
const tz = computed(() => store.settings.timezone)
const view = ref('month')
const anchor = ref(new Date().toISOString().slice(0, 10))
const selectedDay = ref(anchor.value)
const caseFilter = ref(route.query.case ? Number(route.query.case) : '')
const caseOptions = ref([])
const data = ref(null)
const caseInfo = ref(null)
const stale = ref(false)
const cachedAt = ref(null)
const error = ref('')
const errorCode = ref('ERROR')
const overdueTarget = ref(null)
const completeError = ref('')
const saving = ref(false)

const range = computed(() => (view.value === 'month' ? monthGrid(anchor.value) : weekRange(anchor.value)))

const itemMap = computed(() => {
  const m = {}
  for (const d of data.value?.deadlines || []) (m[d.due_date] ||= { deadlines: [], oas: [], all: [] }).deadlines.push(d)
  for (const o of data.value?.office_actions || []) (m[o.dispatch_date] ||= { deadlines: [], oas: [], all: [] }).oas.push(o)
  for (const k of Object.keys(m)) m[k].all = [...m[k].deadlines.map((x) => ({ ...x, __kind: 'deadline' })), ...m[k].oas.map((x) => ({ ...x, __kind: 'oa' }))]
  return m
})
const byDate = (day) => itemMap.value[day] || { deadlines: [], oas: [], all: [] }
const selectedItems = computed(() => byDate(selectedDay.value).all)
const hasAnyItem = computed(() => (data.value?.deadlines?.length || 0) + (data.value?.office_actions?.length || 0) > 0)

// 案件维度三种空态判定：无官文且区间内也无任何期限落点 → 无官文；
// 有官文但全撤回且区间无有效落点 → 全撤回；否则若区间无落点 → 普通空区间
const caseEmpty = computed(() => {
  if (!caseFilter.value || !caseInfo.value) return ''
  const oas = caseInfo.value.office_actions || []
  if (hasAnyItem.value) return ''
  if (!oas.length) return 'no_oa'
  if (oas.every((o) => o.status === 'withdrawn')) return 'all_withdrawn'
  return ''
})
const caseTitle = computed(() => caseInfo.value?.title || '')
const withdrawnCount = computed(() => (caseInfo.value?.office_actions || []).length)
const withdrawnCaseStatus = computed(() => caseInfo.value?.status || '申请')
const withdrawnReasons = computed(() => (caseInfo.value?.office_actions || []).filter((o) => o.status === 'withdrawn'))

function inMonth(day) {
  return view.value === 'week' || day.slice(0, 7) === anchor.value.slice(0, 7)
}
function weekdayName(day) {
  return '周' + WEEKDAY_LABELS[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]
}
function dClass(d) {
  if (d.status === '已完成') return 'is-done'
  return dday(d.due_date, data.value?.today).cls === 'bad' ? 'is-bad' : dday(d.due_date, data.value?.today).cls === 'warn' ? 'is-warn' : 'is-ok'
}

function setView(v) {
  view.value = v
  selectedDay.value = anchor.value
  reload()
}
function shift(delta) {
  anchor.value = view.value === 'month' ? shiftMonth(anchor.value, delta) : shiftWeek(anchor.value, delta)
  reload()
}
function goToday() {
  anchor.value = new Date().toISOString().slice(0, 10)
  selectedDay.value = anchor.value
  reload()
}
function openCase(id) {
  router.push(`/cases/${id}`)
}

async function loadCaseOptions() {
  try {
    const r = await get('/cases')
    caseOptions.value = r.data
  } catch {}
}

async function reload() {
  error.value = ''
  const { from, to } = range.value
  try {
    const params = new URLSearchParams({ from, to })
    if (caseFilter.value) {
      params.set('case_id', caseFilter.value)
      const cd = await get(`/cases/${caseFilter.value}`)
      caseInfo.value = cd.data
    } else {
      caseInfo.value = null
    }
    const r = await get(`/calendar?${params.toString()}`, { cacheKey: `cal:${from}:${to}:${caseFilter.value || 'all'}` })
    data.value = r.data
    stale.value = r.stale
    cachedAt.value = r.cachedAt
    if (!itemMap.value[selectedDay.value]?.all?.length) {
      const first = range.value.days.find((d) => byDate(d).all.length)
      if (first) selectedDay.value = first
    }
  } catch (e) {
    error.value = e.code === 'NETWORK' ? '日历加载失败：当前离线且暂无该时段缓存，请联网后重试' : `日历加载失败：${e.message}`
    errorCode.value = e.code
  }
}

function onComplete(d) {
  if (d.overdue || d.due_date < data.value?.today) {
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
    else store.showToast('期限已办结', 'success')
    await reload()
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

onMounted(() => {
  if (!store.settings?.timezone) store.setSettings({ timezone: 'Asia/Shanghai' })
  loadCaseOptions()
  reload()
  window.addEventListener('pc:synced', reload)
})
onUnmounted(() => window.removeEventListener('pc:synced', reload))
</script>
