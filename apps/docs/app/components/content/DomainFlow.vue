<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const steps = [
  {
    label: 'User adds domain',
    status: 'registering',
    statusColor: 'brand',
    detail: 'Domain record created in database',
    type: 'action',
  },
  {
    label: 'Provider registration',
    status: null,
    detail: 'Lifecycle effect: register_with_provider (per-adapter action)',
    type: 'gate',
    branches: [
      { label: 'Success', detail: 'DNS records populated', status: 'pending', statusColor: 'warning', type: 'result' },
      { label: 'Failure', detail: 'lastRegistrationError set', status: 'failed', statusColor: 'danger', type: 'error' },
    ],
  },
  {
    label: 'User clicks Verify',
    status: null,
    detail: 'DNS + SES checks triggered',
    type: 'action',
    branches: [
      { label: 'All checks pass', detail: '', status: 'verified', statusColor: 'success', type: 'result' },
      { label: 'Checks fail', detail: '', status: 'failed', statusColor: 'danger', type: 'error' },
    ],
  },
]
</script>

<template>
  <div class="domain-flow" :class="{ 'is-visible': visible }">
    <div class="df-track">
      <div class="df-line" />

      <div
        v-for="(step, si) in steps"
        :key="si"
        class="df-step"
        :style="{ '--si': si }"
      >
        <!-- Main step -->
        <div class="df-step-main">
          <div class="df-node" :class="`df-node--${step.type}`">
            <div class="df-node-dot" />
          </div>
          <div class="df-content">
            <div class="df-content-row">
              <span class="df-label">{{ step.label }}</span>
              <code v-if="step.status" class="df-status" :class="`df-status--${step.statusColor}`">{{ step.status }}</code>
            </div>
            <span v-if="step.detail" class="df-detail">{{ step.detail }}</span>
          </div>
        </div>

        <!-- Branches -->
        <div v-if="step.branches" class="df-branches">
          <div
            v-for="(branch, bi) in step.branches"
            :key="bi"
            class="df-branch"
            :class="`df-branch--${branch.type}`"
            :style="{ '--bi': si * 2 + bi + 1 }"
          >
            <div class="df-branch-connector">
              <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
                <path d="M0 0v6a4 4 0 004 4h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </div>
            <div class="df-branch-content">
              <span class="df-branch-label">{{ branch.label }}</span>
              <span v-if="branch.detail" class="df-branch-detail">{{ branch.detail }}</span>
              <code v-if="branch.status" class="df-status df-status--sm" :class="`df-status--${branch.statusColor}`">{{ branch.status }}</code>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.domain-flow {
  margin: 2rem 0;
}

.df-track {
  position: relative;
  padding-left: 28px;
}

.df-line {
  position: absolute;
  left: 9px;
  top: 10px;
  bottom: 10px;
  width: 2px;
  background: linear-gradient(
    to bottom,
    var(--color-brand-dim),
    var(--color-warning),
    var(--color-success)
  );
  border-radius: 1px;
  transform-origin: top;
  transform: scaleY(0);
  transition: transform 0.8s var(--ease-out-expo) 0.2s;
}

.is-visible .df-line {
  transform: scaleY(1);
}

/* Steps */
.df-step {
  margin-bottom: 16px;
  opacity: 0;
  transform: translateX(-8px);
  transition: opacity 0.5s var(--ease-out-expo), transform 0.5s var(--ease-out-expo);
  transition-delay: calc(0.15s + var(--si) * 0.15s);
}

.df-step:last-child {
  margin-bottom: 0;
}

.is-visible .df-step {
  opacity: 1;
  transform: translateX(0);
}

.df-step-main {
  display: flex;
  align-items: flex-start;
  gap: 0;
}

/* Node */
.df-node {
  position: absolute;
  left: -28px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  left: -28px;
  flex-shrink: 0;
}

.df-node-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--color-brand-dim);
  background: var(--color-bg-elevated);
  transition: border-color 0.3s, box-shadow 0.3s;
}

.df-node--action .df-node-dot { border-color: var(--color-brand-dim); }
.df-node--gate .df-node-dot { border-color: var(--color-warning); }
.df-node--result .df-node-dot { border-color: var(--color-success); }

.df-step:hover .df-node-dot {
  box-shadow: 0 0 10px rgba(196, 120, 90, 0.25);
}

/* Content */
.df-content {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 14px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  border: 1px solid transparent;
  flex: 1;
  transition: border-color 0.25s, background 0.25s;
}

.df-step:hover .df-content {
  border-color: var(--color-border-default);
  background: var(--color-bg-surface-hover);
}

.df-content-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.df-label {
  font-weight: 500;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
}

.df-detail {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

.df-status {
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 0.625rem;
  font-family: var(--font-mono);
  font-weight: 600;
  white-space: nowrap;
}

.df-status--brand {
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
  color: var(--color-brand);
  border: 1px solid color-mix(in oklab, var(--color-brand) 25%, transparent);
}

.df-status--warning {
  background: color-mix(in oklab, var(--color-warning) 12%, var(--color-bg-surface));
  color: var(--color-warning);
  border: 1px solid color-mix(in oklab, var(--color-warning) 25%, transparent);
}

.df-status--success {
  background: color-mix(in oklab, var(--color-success) 12%, var(--color-bg-surface));
  color: var(--color-success);
  border: 1px solid color-mix(in oklab, var(--color-success) 25%, transparent);
}

.df-status--danger {
  background: color-mix(in oklab, #c45a5a 12%, var(--color-bg-surface));
  color: #c45a5a;
  border: 1px solid color-mix(in oklab, #c45a5a 25%, transparent);
}

.df-status--sm {
  font-size: 0.5625rem;
  padding: 1px 6px;
  margin-left: 4px;
}

/* Branches */
.df-branches {
  margin-left: 14px;
  padding-left: 18px;
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.df-branch {
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0;
  transform: translateX(-6px);
  transition: opacity 0.5s var(--ease-out-expo), transform 0.5s var(--ease-out-expo);
}

.is-visible .df-branch {
  opacity: 1;
  transform: translateX(0);
  transition-delay: calc(0.2s + var(--bi) * 0.1s);
}

.df-branch-connector {
  flex-shrink: 0;
}

.df-branch--result .df-branch-connector { color: var(--color-success); opacity: 0.5; }
.df-branch--error .df-branch-connector { color: #c45a5a; opacity: 0.5; }

.df-branch-content {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  transition: border-color 0.25s;
}

.df-branch:hover .df-branch-content {
  border-color: var(--color-border-default);
}

.df-branch-label {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--color-text-secondary);
}

.df-branch-detail {
  font-size: 0.625rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

@media (max-width: 580px) {
  .df-branch-detail {
    display: none;
  }
}

/* Ambient */
.is-visible .df-node-dot {
  animation: df-pulse 3s ease-in-out infinite;
  animation-delay: calc(var(--si, 0) * 0.5s + 1s);
}

@keyframes df-pulse {
  0%, 100% { box-shadow: 0 0 0 0 transparent; }
  50% { box-shadow: 0 0 8px 1px rgba(196, 120, 90, 0.15); }
}
</style>
