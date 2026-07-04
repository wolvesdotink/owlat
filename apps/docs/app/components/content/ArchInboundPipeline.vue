<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const steps = [
  {
    id: 'inbound',
    label: 'Inbound Email',
    detail: 'MTA receives SMTP → parses → forwards to Convex',
    icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
    color: 'accent',
  },
  {
    id: 'filter',
    label: 'Content Filter',
    detail: 'Prompt injection · instruction smuggling · content policy · metadata stripping',
    icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
    color: 'warning',
  },
  {
    id: 'context',
    label: '1. Context Retrieval',
    detail: 'Contact history, thread, knowledge graph, org policies',
    icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
    color: 'brand',
  },
  {
    id: 'classify',
    label: '2. Classification',
    detail: 'Category, priority, sentiment, intent, confidence',
    icon: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z',
    color: 'brand',
  },
  {
    id: 'plan',
    label: '3. Action Planning',
    detail: 'Reply, forward, escalate, create ticket, archive',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
    color: 'brand',
  },
  {
    id: 'draft',
    label: '4. Draft Generation',
    detail: 'Grounded in org tone, real data, templates',
    icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
    color: 'brand',
  },
  {
    id: 'route',
    label: '5. Routing',
    detail: 'Auto-approve or → Verification Queue',
    icon: 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4',
    color: 'brand',
  },
]

const outcomes = [
  { label: 'Auto-send', condition: 'High confidence', icon: 'M13 10V3L4 14h7v7l9-11h-7z', color: 'success' },
  { label: 'Human review', condition: 'Below threshold', icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z', color: 'brand' },
  { label: 'Escalate', condition: 'Complaint / sensitive', icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z', color: 'error' },
]
</script>

<template>
  <div class="ip" :class="{ 'is-visible': visible }">
    <!-- Pipeline steps -->
    <div class="ip-pipeline">
      <div
        v-for="(step, i) in steps"
        :key="step.id"
        class="ip-step"
        :class="`ip-step--${step.color}`"
        :style="{ '--i': i }"
      >
        <div class="ip-step-icon" :class="`ip-step-icon--${step.color}`">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="step.icon" /></svg>
        </div>
        <div class="ip-step-content">
          <span class="ip-step-label">{{ step.label }}</span>
          <span class="ip-step-detail">{{ step.detail }}</span>
        </div>
        <!-- Arrow between steps -->
        <div v-if="i < steps.length - 1" class="ip-arrow">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 5l7 7-7 7" /></svg>
        </div>
      </div>
    </div>

    <!-- Routing outcomes -->
    <div class="ip-outcomes" :style="{ '--stagger': 1 }">
      <div class="ip-outcomes-header">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
        <span>Routing outcomes</span>
      </div>
      <div class="ip-outcomes-grid">
        <div
          v-for="outcome in outcomes"
          :key="outcome.label"
          class="ip-outcome"
          :class="`ip-outcome--${outcome.color}`"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="outcome.icon" /></svg>
          <div class="ip-outcome-text">
            <span class="ip-outcome-label">{{ outcome.label }}</span>
            <span class="ip-outcome-condition">{{ outcome.condition }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ip {
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Pipeline */
.ip-pipeline {
  display: flex;
  flex-direction: column;
  gap: 0;
  position: relative;
}

.ip-step {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 9px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-default);
  position: relative;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring), border-color var(--motion-moderate);
  transition-delay: calc(0.08s + var(--i) * 0.08s);
  margin-bottom: 4px;
}

.is-visible .ip-step {
  opacity: 1;
  transform: translateY(0);
}

.ip-step:hover {
  border-color: var(--color-border-strong);
  transition-delay: 0s;
}

.ip-step-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  flex-shrink: 0;
}

.ip-step-icon--brand { background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface)); color: var(--color-brand); }
.ip-step-icon--accent { background: color-mix(in oklab, var(--color-accent) 10%, var(--color-bg-surface)); color: var(--color-accent); }
.ip-step-icon--warning { background: color-mix(in oklab, var(--color-warning) 10%, var(--color-bg-surface)); color: var(--color-warning); }

.ip-step-content {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
}

.ip-step-label {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  line-height: 1.3;
}

.ip-step--accent .ip-step-label { color: var(--color-accent); }
.ip-step--warning .ip-step-label { color: var(--color-warning); }

.ip-step-detail {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
}

.ip-arrow {
  display: none;
}

/* Connector line between steps */
.ip-step:not(:last-child)::after {
  content: '';
  position: absolute;
  bottom: -4px;
  left: 23px;
  width: 1.5px;
  height: 4px;
  background: var(--color-border-default);
}

/* Outcomes */
.ip-outcomes {
  border: 1px solid var(--color-border-default);
  border-radius: 10px;
  background: var(--color-bg-elevated);
  overflow: hidden;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.12s + 0.5s);
}

.is-visible .ip-outcomes {
  opacity: 1;
  transform: translateY(0);
}

.ip-outcomes-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: var(--color-bg-soft);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.ip-outcomes-header svg {
  color: var(--color-text-tertiary);
}

.ip-outcomes-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0;
}

@media (max-width: 500px) {
  .ip-outcomes-grid {
    grid-template-columns: 1fr;
  }
}

.ip-outcome {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-right: 1px solid var(--color-border-subtle);
}

.ip-outcome:last-child {
  border-right: none;
}

.ip-outcome--success svg { color: var(--color-success); }
.ip-outcome--brand svg { color: var(--color-brand); }
.ip-outcome--error svg { color: var(--color-error); }

.ip-outcome-text {
  display: flex;
  flex-direction: column;
}

.ip-outcome-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.ip-outcome-condition {
  font-size: 0.625rem;
  color: var(--color-text-tertiary);
}
</style>
