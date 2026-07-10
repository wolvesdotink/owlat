<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const layers = [
  {
    id: 'tenant',
    label: 'Tenant Isolation',
    icon: 'M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    color: 'brand',
    detail: 'Every operation scoped by organizationId',
    items: [
      { label: 'Org A', state: 'active' },
      { label: 'Org B', state: 'blocked' },
      { label: 'Org C', state: 'blocked' },
    ],
  },
  {
    id: 'sandbox',
    label: 'Agent Sandboxing',
    icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    color: 'accent',
    detail: 'Credential-scoped, minimum permissions',
    items: [
      { label: 'Booking API', state: 'scoped' },
      { label: 'CRM read', state: 'scoped' },
      { label: 'Admin API', state: 'denied' },
    ],
  },
  {
    id: 'audit',
    label: 'Audit & Explainability',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    color: 'info',
    detail: 'Full provenance on every action',
    items: [
      { label: 'Knowledge retrieved', state: 'logged' },
      { label: 'Reasoning trace', state: 'logged' },
      { label: 'Approval chain', state: 'logged' },
    ],
  },
  {
    id: 'autonomy',
    label: 'Graduated Autonomy',
    icon: 'M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4',
    color: 'success',
    detail: 'Organizations control the trust boundary',
    items: [
      { label: 'Auto-approve simple', state: 'auto' },
      { label: 'Review complex', state: 'human' },
      { label: 'Escalate sensitive', state: 'human' },
    ],
  },
]

const stateIcons: Record<string, string> = {
  active: 'M5 13l4 4L19 7',
  blocked: 'M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636',
  scoped: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
  denied: 'M6 18L18 6M6 6l12 12',
  logged: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
  auto: 'M13 10V3L4 14h7v7l9-11h-7z',
  human: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
}
</script>

<template>
  <div class="sec" :class="{ 'is-visible': visible }">

    <!-- Nested rings visualization -->
    <div class="sec-rings" :style="{ '--stagger': 0 }">
      <div class="sec-rings-visual">
        <!-- Outermost ring: Tenant isolation -->
        <div class="sec-ring sec-ring--tenant">
          <span class="sec-ring-label sec-ring-label--top">Tenant Isolation</span>
          <!-- Second ring: Sandboxing -->
          <div class="sec-ring sec-ring--sandbox">
            <span class="sec-ring-label sec-ring-label--top">Agent Sandbox</span>
            <!-- Third ring: Audit -->
            <div class="sec-ring sec-ring--audit">
              <span class="sec-ring-label sec-ring-label--top">Audit Trail</span>
              <!-- Core: Agent -->
              <div class="sec-core">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                <span>Agent</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="sec-rings-desc">
        Every agent operates within nested security boundaries. No layer can be bypassed.
      </div>
    </div>

    <!-- Four security layers -->
    <div class="sec-layers" :style="{ '--stagger': 1 }">
      <div
        v-for="(layer, i) in layers"
        :key="layer.id"
        class="sec-layer"
        :class="`sec-layer--${layer.color}`"
        :style="{ '--i': i }"
      >
        <div class="sec-layer-header">
          <div class="sec-layer-icon" :class="`sec-layer-icon--${layer.color}`">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="layer.icon" /></svg>
          </div>
          <div class="sec-layer-title-group">
            <span class="sec-layer-title">{{ layer.label }}</span>
            <span class="sec-layer-detail">{{ layer.detail }}</span>
          </div>
        </div>
        <div class="sec-layer-items">
          <div
            v-for="item in layer.items"
            :key="item.label"
            class="sec-layer-item"
            :class="`sec-layer-item--${item.state}`"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="stateIcons[item.state]" /></svg>
            <span>{{ item.label }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Data flow example -->
    <div class="sec-example" :style="{ '--stagger': 2 }">
      <div class="sec-example-header">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
        <span class="sec-example-title">Example: Agent processes support email for Customer A</span>
      </div>
      <div class="sec-example-steps">
        <div class="sec-example-step">
          <span class="sec-example-check sec-example-check--pass">✓</span>
          <span class="sec-example-text">Tenant gate — agent context loaded for Org X only</span>
        </div>
        <div class="sec-example-step">
          <span class="sec-example-check sec-example-check--pass">✓</span>
          <span class="sec-example-text">Sandbox — booking API credentials scoped to Customer A</span>
        </div>
        <div class="sec-example-step">
          <span class="sec-example-check sec-example-check--fail">✗</span>
          <span class="sec-example-text">Customer B's booking data — <strong>access denied</strong></span>
        </div>
        <div class="sec-example-step">
          <span class="sec-example-check sec-example-check--pass">✓</span>
          <span class="sec-example-text">Draft produced — full trace logged to audit</span>
        </div>
        <div class="sec-example-step">
          <span class="sec-example-check sec-example-check--pass">✓</span>
          <span class="sec-example-text">Routed to verification queue — human reviews before send</span>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.sec {
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── Nested rings visualization ── */
.sec-rings {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 24px 16px;
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
  background: var(--color-bg-elevated);
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateY(12px);
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring), border-color var(--motion-moderate);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.sec-rings::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 50% 50%, rgba(196, 120, 90, 0.03) 0%, transparent 70%);
  pointer-events: none;
}

.is-visible .sec-rings {
  opacity: 1;
  transform: translateY(0);
}

.sec-rings:hover {
  border-color: var(--color-border-strong);
}

.sec-rings-visual {
  position: relative;
}

/* Concentric rings */
.sec-ring {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  position: relative;
}

.sec-ring--tenant {
  width: 260px;
  height: 260px;
  border: 1.5px solid color-mix(in oklab, var(--color-brand) 30%, var(--color-border-default));
  background: color-mix(in oklab, var(--color-brand) 2%, var(--color-bg-elevated));
}

.sec-ring--sandbox {
  width: 180px;
  height: 180px;
  border: 1.5px solid color-mix(in oklab, var(--color-accent) 30%, var(--color-border-default));
  background: color-mix(in oklab, var(--color-accent) 2%, var(--color-bg-elevated));
}

.sec-ring--audit {
  width: 110px;
  height: 110px;
  border: 1.5px solid color-mix(in oklab, var(--color-info) 30%, var(--color-border-default));
  background: color-mix(in oklab, var(--color-info) 2%, var(--color-bg-elevated));
}

.sec-ring-label {
  position: absolute;
  font-size: 0.5625rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  white-space: nowrap;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--color-bg-elevated);
}

.sec-ring-label--top {
  top: -1px;
  left: 50%;
  transform: translate(-50%, -50%);
}

.sec-ring--tenant > .sec-ring-label { color: var(--color-brand); }
.sec-ring--sandbox > .sec-ring-label { color: var(--color-accent); }
.sec-ring--audit > .sec-ring-label { color: var(--color-info); }

/* Ambient ring pulse */
.is-visible .sec-ring--tenant {
  animation: ring-pulse-brand 4s ease-in-out infinite 1s;
}

.is-visible .sec-ring--sandbox {
  animation: ring-pulse-accent 4s ease-in-out infinite 1.5s;
}

.is-visible .sec-ring--audit {
  animation: ring-pulse-info 4s ease-in-out infinite 2s;
}

@keyframes ring-pulse-brand {
  0%, 100% { border-color: color-mix(in oklab, var(--color-brand) 30%, var(--color-border-default)); }
  50% { border-color: color-mix(in oklab, var(--color-brand) 50%, var(--color-border-default)); }
}

@keyframes ring-pulse-accent {
  0%, 100% { border-color: color-mix(in oklab, var(--color-accent) 30%, var(--color-border-default)); }
  50% { border-color: color-mix(in oklab, var(--color-accent) 50%, var(--color-border-default)); }
}

@keyframes ring-pulse-info {
  0%, 100% { border-color: color-mix(in oklab, var(--color-info) 30%, var(--color-border-default)); }
  50% { border-color: color-mix(in oklab, var(--color-info) 50%, var(--color-border-default)); }
}

/* Core agent */
.sec-core {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  color: var(--color-success);
}

.sec-core svg {
  opacity: 0;
  transform: scale(0.6);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
}

.is-visible .sec-core svg {
  opacity: 1;
  transform: scale(1);
  transition-delay: 0.5s;
}

.sec-core span {
  font-size: 0.625rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.sec-rings-desc {
  font-size: 0.75rem;
  color: var(--color-text-tertiary);
  text-align: center;
  position: relative;
}

@media (max-width: 400px) {
  .sec-ring--tenant { width: 200px; height: 200px; }
  .sec-ring--sandbox { width: 140px; height: 140px; }
  .sec-ring--audit { width: 86px; height: 86px; }
}

/* ── Four layers detail grid ── */
.sec-layers {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .sec-layers {
  opacity: 1;
  transform: translateY(0);
}

@media (max-width: 540px) {
  .sec-layers {
    grid-template-columns: 1fr;
  }
}

.sec-layer {
  padding: 12px 14px;
  border-radius: 9px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-default);
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.45s var(--ease-spring), transform 0.45s var(--ease-spring), border-color var(--motion-moderate), box-shadow var(--motion-moderate);
  transition-delay: calc(0.2s + var(--i) * 0.07s);
}

.is-visible .sec-layer {
  opacity: 1;
  transform: translateY(0);
}

.sec-layer:hover {
  border-color: var(--color-border-strong);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
  transition-delay: 0s;
}

.sec-layer-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.sec-layer-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  flex-shrink: 0;
  transition: box-shadow var(--motion-moderate);
}

.sec-layer:hover .sec-layer-icon {
  box-shadow: 0 0 8px rgba(196, 120, 90, 0.1);
}

.sec-layer-icon--brand { background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface)); color: var(--color-brand); }
.sec-layer-icon--accent { background: color-mix(in oklab, var(--color-accent) 10%, var(--color-bg-surface)); color: var(--color-accent); }
.sec-layer-icon--info { background: color-mix(in oklab, var(--color-info) 10%, var(--color-bg-surface)); color: var(--color-info); }
.sec-layer-icon--success { background: color-mix(in oklab, var(--color-success) 10%, var(--color-bg-surface)); color: var(--color-success); }

.sec-layer-title-group {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
}

.sec-layer-title {
  font-weight: var(--font-weight-semibold);
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  line-height: 1.3;
}

.sec-layer--brand .sec-layer-title { color: var(--color-brand); }
.sec-layer--accent .sec-layer-title { color: var(--color-accent); }
.sec-layer--info .sec-layer-title { color: var(--color-info); }
.sec-layer--success .sec-layer-title { color: var(--color-success); }

.sec-layer-detail {
  font-size: 0.625rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

/* Layer items */
.sec-layer-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sec-layer-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 0.6875rem;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
}

.sec-layer-item span {
  color: var(--color-text-secondary);
}

.sec-layer-item--active svg { color: var(--color-success); }
.sec-layer-item--blocked svg { color: var(--color-error); }
.sec-layer-item--blocked span { color: var(--color-text-tertiary); }
.sec-layer-item--scoped svg { color: var(--color-accent); }
.sec-layer-item--denied svg { color: var(--color-error); }
.sec-layer-item--denied span { color: var(--color-text-tertiary); }
.sec-layer-item--logged svg { color: var(--color-info); }
.sec-layer-item--auto svg { color: var(--color-success); }
.sec-layer-item--human svg { color: var(--color-brand); }

/* ── Example scenario ── */
.sec-example {
  border: 1px solid color-mix(in oklab, var(--color-brand) 15%, var(--color-border-default));
  border-radius: 10px;
  background: var(--color-bg-elevated);
  overflow: hidden;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring), box-shadow var(--motion-moderate);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .sec-example {
  opacity: 1;
  transform: translateY(0);
}

.sec-example:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
}

.sec-example-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  background: color-mix(in oklab, var(--color-brand) 3%, var(--color-bg-soft));
  border-bottom: 1px solid var(--color-border-subtle);
}

.sec-example-header svg {
  color: var(--color-brand);
  flex-shrink: 0;
}

.sec-example-title {
  font-size: 0.75rem;
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.sec-example-steps {
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sec-example-step {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.sec-example-check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-size: 0.625rem;
  font-weight: 700;
  flex-shrink: 0;
  line-height: 1;
}

.sec-example-check--pass {
  background: color-mix(in oklab, var(--color-success) 12%, var(--color-bg-surface));
  color: var(--color-success);
  border: 1px solid color-mix(in oklab, var(--color-success) 25%, var(--color-border-subtle));
}

.sec-example-check--fail {
  background: color-mix(in oklab, var(--color-error) 12%, var(--color-bg-surface));
  color: var(--color-error);
  border: 1px solid color-mix(in oklab, var(--color-error) 25%, var(--color-border-subtle));
}

.sec-example-text {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.sec-example-text strong {
  color: var(--color-error);
  font-weight: var(--font-weight-semibold);
}
</style>
