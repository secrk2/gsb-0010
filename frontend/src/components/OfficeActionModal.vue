<template>
  <Modal :title="'登记官文'" @close="$emit('close')">
    <div class="field">
      <label>官文类型 *</label>
      <select v-model="form.oa_type" @change="onType">
        <option value="" disabled>请选择</option>
        <option v-for="o in options" :key="o.key" :value="o.key">
          {{ o.label }}{{ o.target ? `（案件 → ${o.target}）` : '（不改变状态）' }}
        </option>
      </select>
      <p v-if="selected" class="small muted" style="margin:6px 0 0">
        登记后案件状态：<strong>{{ selected.target || `保持「${status}」` }}</strong>
      </p>
    </div>

    <div class="grid grid-2">
      <div class="field">
        <label>发文日 *</label>
        <input v-model="form.dispatch_date" type="date" />
      </div>
      <div class="field">
        <label>实际收到/签收日</label>
        <input v-model="form.receive_date" type="date" />
      </div>
    </div>
    <p class="small" :class="receiveHint.cls" style="margin:-4px 0 10px">
      起算口径雷区：{{ receiveHint.text }}
    </p>

    <div class="field">
      <label>推定送达天数（未填实际收到日时使用）</label>
      <input v-model.number="form.presumed_days" type="number" min="1" style="max-width: 160px" />
    </div>
    <div class="field">
      <label>官方文号</label>
      <input v-model="form.doc_no" placeholder="如 第 123456 号" />
    </div>

    <div v-if="needAgent" class="field">
      <label>指派承办代理人 *（受理时派案）</label>
      <select v-model="form.agent_id">
        <option :value="null" disabled>请选择</option>
        <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
      </select>
    </div>

    <div v-if="deadlineRows.length" class="field">
      <label>将自动派生的答复/办理期限（口径可改，到期日由系统推算）</label>
      <div v-for="(r, i) in deadlineRows" :key="i" class="dl-tpl">
        <input v-model="r.title" class="dl-tpl-name" placeholder="期限事项" />
        <select v-model="r.base_type">
          <option value="receive">自收到日</option>
          <option value="dispatch">自发文日</option>
        </select>
        <input v-model.number="r.window_value" type="number" min="1" class="dl-tpl-n" />
        <select v-model="r.window_unit">
          <option value="day">天</option>
          <option value="month">个月</option>
        </select>
        <select v-model="r.day_basis">
          <option value="natural">自然日</option>
          <option value="workday">工作日</option>
          <option value="legal">法定节假日口径</option>
        </select>
      </div>
      <p class="small muted" style="margin:6px 0 0">到期日遇法定休假日依法顺延；自收到日且未填实际收到日时，按发文日 + {{ form.presumed_days || 15 }} 天推定。</p>
    </div>

    <div class="field">
      <label>备注</label>
      <textarea v-model="form.note" rows="2" placeholder="将随官文与流转记录留痕"></textarea>
    </div>

    <p v-if="error" class="small bad-text">{{ error }}</p>
    <div class="modal-actions">
      <button class="btn" @click="$emit('close')">取消</button>
      <button class="btn primary" :disabled="saving || !form.oa_type || !form.dispatch_date" @click="submit">登记官文</button>
    </div>
  </Modal>
</template>

<script setup>
import { ref, computed } from 'vue'
import { store } from '../store.js'

const props = defineProps({
  options: { type: Array, required: true },
  agents: { type: Array, default: () => [] },
  status: String,
  saving: Boolean,
  error: String,
})
const emit = defineEmits(['close', 'submit'])

const form = ref({
  oa_type: '', dispatch_date: '', receive_date: '', presumed_days: 15, doc_no: '', note: '', agent_id: null,
})
const deadlineRows = ref([])

const selected = computed(() => props.options.find((o) => o.key === form.value.oa_type))
const needAgent = computed(() => selected.value?.target === '受理')
const receiveHint = computed(() => {
  const f = form.value
  if (!f.dispatch_date) return { text: '请先选发文日；实际收到日留空则按推定收到日起算。', cls: 'muted' }
  const add = (base, n) => {
    const d = new Date(`${base}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + Number(n || 15))
    return d.toISOString().slice(0, 10)
  }
  if (f.receive_date) {
    const gap = Math.round((Date.parse(f.receive_date + 'T00:00:00Z') - Date.parse(f.dispatch_date + 'T00:00:00Z')) / 86400000)
    return { text: `以实际收到日 ${f.receive_date} 为准（晚于发文日 ${gap} 天）。`, cls: 'brand-text' }
  }
  return { text: `未填实际收到日：推定收到日 = 发文日 + ${f.presumed_days || 15} 天 = ${add(f.dispatch_date, f.presumed_days)}，「自收到日」期限按此日起算。`, cls: 'warn-text' }
})

function onType() {
  const o = selected.value
  deadlineRows.value = (o?.deadlines || []).map((d) => ({ ...d }))
  if (o?.target === '受理') form.value.agent_id = props.agents[0]?.id ?? null
}

function submit() {
  const f = form.value
  if (f.receive_date && f.receive_date < f.dispatch_date) {
    emit('submit', { __error: '实际收到日不能早于发文日' })
    return
  }
  const payload = {
    oa_type: f.oa_type,
    dispatch_date: f.dispatch_date,
    receive_date: f.receive_date || null,
    presumed_days: f.presumed_days,
    doc_no: f.doc_no,
    note: f.note,
    deadlines: deadlineRows.value,
  }
  if (needAgent.value) payload.agent_id = f.agent_id
  emit('submit', payload)
}
</script>
