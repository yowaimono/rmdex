<script setup lang="ts">
import { CalendarClock, ChevronDown, Clock3 } from 'lucide-vue-next'
import type { PlanExecution } from '../conversation'

defineProps<{ execution: PlanExecution; prompt?: string }>()
</script>

<template>
  <section class="plan-execution-card" aria-label="计划任务执行">
    <div class="plan-execution-icon"><CalendarClock :size="19" /></div>
    <div class="plan-execution-content">
      <div class="plan-execution-heading">
        <strong>{{ execution.planName }}</strong>
        <span class="plan-execution-status">已触发</span>
      </div>
      <div class="plan-execution-meta"><Clock3 :size="13" />后台执行中</div>
      <details v-if="prompt" class="plan-execution-details">
        <summary>查看任务内容 <ChevronDown :size="14" /></summary>
        <p>{{ prompt }}</p>
      </details>
    </div>
  </section>
</template>
