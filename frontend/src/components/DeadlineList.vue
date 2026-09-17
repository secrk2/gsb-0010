<template>
  <div class="deadline-list">
    <div v-for="it in items" :key="it.__kind + it.id" class="dl-item" :class="{ 'is-oa': it.__kind === 'oa' }">
      <template v-if="it.__kind === 'oa'">
        <div class="spread">
          <div>
            <strong>📄 {{ it.oa_type_label }}</strong>
            <span v-if="it.target_status" class="chip blue">→ {{ it.target_status }}</span>
          </div>
          <span class="small muted">发文 {{ it.dispatch_date }}</span>
        </div>
        <div class="small muted mt8">{{ it.case_no }} · {{ it.case_title }} · {{ it.client_name }}</div>
        <div class="mt8"><button class="btn sm" @click="$emit('open', it.case_id)">查看案件</button></div>
      </template>

      <template v-else>
        <div class="spread">
          <div>
            <strong>{{ it.dtype }}</strong>
            <span v-if="it.status === '已完成'" class="chip ok">已完成</span>
            <span v-else class="chip" :class="dday(it.due_date, today).cls">{{ dday(it.due_date, today).text }}</span>
            <span v-if="it.voided" class="chip warn">已作废</span>
          </div>
          <span class="small muted">到期 {{ it.due_date }}</span>
        </div>
        <div v-if="it.base_type" class="basis-line small">
          <span class="basis-tag">{{ it.base_type_label || BASE_TYPE_LABELS[it.base_type] }}</span>
          {{ basisText(it) }}
        </div>
        <div v-if="it.overdue_reason" class="overdue-reason small">
          逾期原因留痕：{{ it.overdue_reason }}<span v-if="it.completed_by_name"> · {{ it.completed_by_name }}</span>
        </div>
        <div v-if="it.voided_reason" class="small warn-text">作废原因：{{ it.voided_reason }}</div>
        <div class="small muted mt8">{{ it.case_no }} · {{ it.case_title }} · {{ it.client_name }}</div>
        <div v-if="isFirm() && it.status !== '已完成' && !it.voided" class="mt8">
          <button class="btn sm" @click="$emit('complete', it)">办结</button>
        </div>
      </template>
    </div>
    <p v-if="!items.length" class="muted small">无事项</p>
  </div>
</template>

<script setup>
import { dday, basisText, BASE_TYPE_LABELS } from '../utils.js'
import { isFirm } from '../store.js'

defineProps({
  items: { type: Array, default: () => [] },
  tz: String,
  today: { type: String, default: () => new Date().toISOString().slice(0, 10) },
})
defineEmits(['complete', 'open'])
</script>
