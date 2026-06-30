<script setup lang="ts">
import { ref, onMounted } from 'vue'

const props = defineProps<{
  title?: string
  steps: Array<{
    label: string
    detail?: string
    type?: 'action' | 'result' | 'gate' | 'final'
  }>
}>()

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const typeIcons: Record<string, string> = {
  action: 'M13 10V3L4 14h7v7l9-11h-7z',
  result: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  gate: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
  final: 'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z',
}

function getIcon(type?: string) {
  return typeIcons[type || 'action'] || typeIcons.action
}
</script>

<template>
  <div class="arch-flow" :class="{ 'is-visible': visible }">
    <div v-if="title" class="arch-flow-title">{{ title }}</div>

    <div class="arch-flow-track">
      <!-- Vertical line -->
      <div class="arch-flow-line" />

      <div
        v-for="(step, i) in steps"
        :key="i"
        class="arch-flow-step"
        :class="`arch-flow-step--${step.type || 'action'}`"
        :style="{ '--step-i': i }"
      >
        <!-- Node circle -->
        <div class="arch-flow-node">
          <div class="arch-flow-node-ring" />
          <svg
            class="arch-flow-node-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path :d="getIcon(step.type)" />
          </svg>
        </div>

        <!-- Content -->
        <div class="arch-flow-content">
          <span class="arch-flow-label">{{ step.label }}</span>
          <span v-if="step.detail" class="arch-flow-detail">{{ step.detail }}</span>
        </div>

        <!-- Arrow between steps -->
        <div v-if="i < steps.length - 1" class="arch-flow-arrow">
          <svg width="8" height="12" viewBox="0 0 8 12" fill="none">
            <path d="M4 0v10m0 0L1 7m3 3l3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.arch-flow {
  margin: 2rem 0;
}

.arch-flow-title {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 16px;
}

.arch-flow-track {
  position: relative;
  padding-left: 28px;
}

/* Vertical connecting line */
.arch-flow-line {
  position: absolute;
  left: 13px;
  top: 14px;
  bottom: 14px;
  width: 2px;
  background: linear-gradient(to bottom, var(--color-brand-dim), var(--color-border-default));
  border-radius: 1px;
  transform-origin: top;
  transform: scaleY(0);
  transition: transform 0.8s var(--ease-out-expo) 0.2s;
}

.is-visible .arch-flow-line {
  transform: scaleY(1);
}

/* Steps */
.arch-flow-step {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 0;
  margin-bottom: 8px;
  opacity: 0;
  transform: translateX(-8px);
  transition: opacity 0.5s var(--ease-out-expo), transform 0.5s var(--ease-out-expo);
  transition-delay: calc(0.15s + var(--step-i) * 0.1s);
}

.is-visible .arch-flow-step {
  opacity: 1;
  transform: translateX(0);
}

.arch-flow-step:hover {
  transition-delay: 0s;
}

.arch-flow-step:last-child {
  margin-bottom: 0;
}

/* Node */
.arch-flow-node {
  position: absolute;
  left: -28px;
  top: 2px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1;
}

.arch-flow-node-ring {
  position: absolute;
  inset: 2px;
  border-radius: 50%;
  border: 2px solid var(--color-brand-dim);
  background: var(--color-bg-elevated);
  transition: border-color 0.3s, box-shadow 0.3s;
}

.arch-flow-step:hover .arch-flow-node-ring {
  border-color: var(--color-brand);
  box-shadow: 0 0 12px rgba(196, 120, 90, 0.25);
}

.arch-flow-step--result .arch-flow-node-ring { border-color: var(--color-success); }
.arch-flow-step--gate .arch-flow-node-ring { border-color: var(--color-warning); }
.arch-flow-step--final .arch-flow-node-ring { border-color: var(--color-accent); }

.arch-flow-step--result:hover .arch-flow-node-ring { border-color: var(--color-success); box-shadow: 0 0 12px rgba(122, 155, 110, 0.3); }
.arch-flow-step--gate:hover .arch-flow-node-ring { border-color: var(--color-warning); box-shadow: 0 0 12px rgba(201, 165, 90, 0.3); }
.arch-flow-step--final:hover .arch-flow-node-ring { border-color: var(--color-accent); box-shadow: 0 0 12px rgba(212, 165, 116, 0.3); }

.arch-flow-node-icon {
  position: relative;
  z-index: 1;
  color: var(--color-brand-muted);
  transition: color 0.25s;
}

.arch-flow-step--result .arch-flow-node-icon { color: var(--color-success); }
.arch-flow-step--gate .arch-flow-node-icon { color: var(--color-warning); }
.arch-flow-step--final .arch-flow-node-icon { color: var(--color-accent); }

/* Content */
.arch-flow-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 14px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  border: 1px solid transparent;
  transition: border-color 0.25s, background 0.25s;
  flex: 1;
}

.arch-flow-step:hover .arch-flow-content {
  border-color: var(--color-border-default);
  background: var(--color-bg-surface-hover);
}

.arch-flow-label {
  font-weight: 500;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  line-height: 1.4;
}

.arch-flow-detail {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

/* Arrow between steps */
.arch-flow-arrow {
  position: absolute;
  left: -21px;
  bottom: -10px;
  color: var(--color-text-disabled);
  display: none;
}

/* ── Ambient animations ── */
.is-visible .arch-flow-node-ring {
  animation: node-ring-pulse 3s ease-in-out infinite;
  animation-delay: calc(var(--step-i) * 0.4s + 1s);
}

@keyframes node-ring-pulse {
  0%, 100% { box-shadow: 0 0 0 0 transparent; }
  50% { box-shadow: 0 0 8px 1px rgba(196, 120, 90, 0.15); }
}

.is-visible .arch-flow-line::after {
  content: '';
  position: absolute;
  left: -1px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-brand-dim);
  animation: traveling-dot 3s ease-in-out infinite 1.5s;
}

@keyframes traveling-dot {
  0% { top: 0; opacity: 0; }
  10% { opacity: 1; }
  90% { opacity: 1; }
  100% { top: 100%; opacity: 0; }
}
</style>
