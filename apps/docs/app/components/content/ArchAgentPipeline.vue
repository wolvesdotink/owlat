<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
const activeStep = ref(-1)
let interval: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
  // Auto-cycle through steps after initial entrance
  setTimeout(() => {
    activeStep.value = 0
    interval = setInterval(() => {
      activeStep.value = (activeStep.value + 1) % 5
    }, 3000)
  }, 1200)
})

const steps = [
  {
    num: 1,
    name: 'Context Retrieval',
    detail: 'Query the Knowledge Graph',
    icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
    color: 'accent',
    sources: ['Customer history', 'Account data', 'Past interactions', 'Org policies'],
    example: 'Retrieves booking #4821, customer profile, Thursday availability data',
  },
  {
    num: 2,
    name: 'Classification',
    detail: 'Determine intent & urgency',
    icon: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z',
    color: 'info',
    intents: [
      { label: 'Booking change', active: true },
      { label: 'Billing', active: false },
      { label: 'Complaint', active: false },
      { label: 'Feature request', active: false },
    ],
    example: 'Intent: booking change · Urgency: normal · Sentiment: neutral',
  },
  {
    num: 3,
    name: 'Action Planning',
    detail: 'Decide what to do',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01',
    color: 'warning',
    actions: [
      { label: 'Fetch Saturday availability', type: 'api' },
      { label: 'Draft confirmation email', type: 'draft' },
      { label: 'Update booking record', type: 'data' },
    ],
    example: 'Plan: check availability → draft reschedule confirmation → queue for review',
  },
  {
    num: 4,
    name: 'Draft Generation',
    detail: 'Produce grounded response',
    icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
    color: 'brand',
    draft: {
      subject: 'Re: Booking reschedule request',
      preview: 'Hi Sarah, your booking has been moved to Saturday at 10am...',
    },
    example: 'Uses org tone, includes booking details, Saturday confirmed available',
  },
  {
    num: 5,
    name: 'Routing',
    detail: 'Deliver or queue for review',
    icon: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6',
    color: 'success',
    routes: [
      { label: 'Verification Queue', desc: 'Human reviews draft', primary: true },
      { label: 'Auto-deliver', desc: 'High confidence, policy allows' },
    ],
    example: 'Confidence: 92% · Routed to support queue · Assigned to agent on shift',
  },
]

function setStep(i: number) {
  activeStep.value = i
  if (interval) {
    clearInterval(interval)
    interval = setInterval(() => {
      activeStep.value = (activeStep.value + 1) % 5
    }, 3000)
  }
}
</script>

<template>
  <div class="pipe" :class="{ 'is-visible': visible }">

    <!-- Incoming message trigger -->
    <div class="pipe-trigger" :style="{ '--stagger': 0 }">
      <div class="pipe-trigger-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
      </div>
      <div class="pipe-trigger-text">
        <span class="pipe-trigger-label">Incoming message</span>
        <span class="pipe-trigger-example">"Can I move my booking from Thursday to Saturday?"</span>
      </div>
    </div>

    <!-- Connector -->
    <div class="pipe-connector-v" :style="{ '--stagger': 0 }">
      <div class="pipe-connector-v-line" />
    </div>

    <!-- Step navigation bar -->
    <div class="pipe-nav" :style="{ '--stagger': 1 }">
      <button
        v-for="(step, i) in steps"
        :key="step.num"
        class="pipe-nav-step"
        :class="[
          `pipe-nav-step--${step.color}`,
          { 'is-active': activeStep === i, 'is-past': activeStep > i }
        ]"
        :style="{ '--i': i }"
        @click="setStep(i)"
      >
        <span class="pipe-nav-num">{{ step.num }}</span>
        <span class="pipe-nav-name">{{ step.name }}</span>
        <!-- Progress line between steps -->
        <div v-if="i < steps.length - 1" class="pipe-nav-connector">
          <div class="pipe-nav-connector-fill" :class="{ 'is-filled': activeStep > i }" />
        </div>
      </button>
    </div>

    <!-- Active step detail panel -->
    <div class="pipe-detail" :style="{ '--stagger': 2 }">
      <div class="pipe-detail-inner">
        <div
          v-for="(step, i) in steps"
          :key="step.num"
          class="pipe-panel"
          :class="[`pipe-panel--${step.color}`, { 'is-active': activeStep === i }]"
        >
          <div class="pipe-panel-header">
            <div class="pipe-panel-icon" :class="`pipe-panel-icon--${step.color}`">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="step.icon" /></svg>
            </div>
            <div class="pipe-panel-title-group">
              <span class="pipe-panel-title">{{ step.name }}</span>
              <span class="pipe-panel-subtitle">{{ step.detail }}</span>
            </div>
          </div>

          <!-- Step 1: Context Retrieval -->
          <div v-if="step.num === 1" class="pipe-panel-body">
            <div class="pipe-sources">
              <div v-for="src in step.sources" :key="src" class="pipe-source">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" /></svg>
                <span>{{ src }}</span>
              </div>
            </div>
          </div>

          <!-- Step 2: Classification -->
          <div v-if="step.num === 2" class="pipe-panel-body">
            <div class="pipe-intents">
              <span
                v-for="intent in step.intents"
                :key="intent.label"
                class="pipe-intent"
                :class="{ 'is-active': intent.active }"
              >{{ intent.label }}</span>
            </div>
          </div>

          <!-- Step 3: Action Planning -->
          <div v-if="step.num === 3" class="pipe-panel-body">
            <div class="pipe-actions-list">
              <div v-for="(action, ai) in step.actions" :key="action.label" class="pipe-action-item">
                <span class="pipe-action-num">{{ ai + 1 }}</span>
                <span class="pipe-action-label">{{ action.label }}</span>
                <span class="pipe-action-type" :class="`pipe-action-type--${action.type}`">{{ action.type }}</span>
              </div>
            </div>
          </div>

          <!-- Step 4: Draft Generation -->
          <div v-if="step.num === 4" class="pipe-panel-body">
            <div class="pipe-draft">
              <div class="pipe-draft-header">
                <span class="pipe-draft-subject">{{ step.draft?.subject }}</span>
              </div>
              <div class="pipe-draft-body">
                <span class="pipe-draft-preview">{{ step.draft?.preview }}</span>
                <span class="pipe-draft-cursor" />
              </div>
            </div>
          </div>

          <!-- Step 5: Routing -->
          <div v-if="step.num === 5" class="pipe-panel-body">
            <div class="pipe-routes">
              <div
                v-for="route in step.routes"
                :key="route.label"
                class="pipe-route"
                :class="{ 'is-primary': route.primary }"
              >
                <span class="pipe-route-label">{{ route.label }}</span>
                <span class="pipe-route-desc">{{ route.desc }}</span>
              </div>
            </div>
          </div>

          <!-- Example output (all steps) -->
          <div class="pipe-panel-example">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            <span>{{ step.example }}</span>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.pipe {
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* ── Color maps ── */
:where(.pipe-nav-step--brand.is-active) { --step-color: var(--color-brand); }
:where(.pipe-nav-step--accent.is-active) { --step-color: var(--color-accent); }
:where(.pipe-nav-step--info.is-active) { --step-color: var(--color-info); }
:where(.pipe-nav-step--warning.is-active) { --step-color: var(--color-warning); }
:where(.pipe-nav-step--success.is-active) { --step-color: var(--color-success); }

/* ── Incoming message trigger ── */
.pipe-trigger {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--color-bg-elevated);
  border: 1px solid color-mix(in oklab, var(--color-info) 20%, var(--color-border-default));
  opacity: 0;
  transform: translateY(10px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .pipe-trigger {
  opacity: 1;
  transform: translateY(0);
}

.pipe-trigger-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--color-info) 10%, var(--color-bg-surface));
  color: var(--color-info);
  flex-shrink: 0;
}

.pipe-trigger-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.pipe-trigger-label {
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-info);
}

.pipe-trigger-example {
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  font-style: italic;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Vertical connector ── */
.pipe-connector-v {
  display: flex;
  justify-content: center;
  padding: 2px 0;
  opacity: 0;
  transition: opacity var(--motion-slow) var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.12s + 0.1s);
}

.is-visible .pipe-connector-v {
  opacity: 1;
}

.pipe-connector-v-line {
  width: 2px;
  height: 14px;
  background: var(--color-border-strong);
  border-radius: 1px;
  transform-origin: top;
}

.is-visible .pipe-connector-v-line {
  animation: v-line-draw 0.4s var(--ease-spring) both;
  animation-delay: 0.2s;
}

@keyframes v-line-draw {
  from { transform: scaleY(0); }
  to { transform: scaleY(1); }
}

/* ── Step navigation bar ── */
.pipe-nav {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 6px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-default);
  border-radius: 10px;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.12s);
  overflow-x: auto;
}

.is-visible .pipe-nav {
  opacity: 1;
  transform: translateY(0);
}

.pipe-nav-step {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  position: relative;
  transition: background var(--motion-moderate), border-color var(--motion-moderate), box-shadow var(--motion-moderate);
  opacity: 0;
  transform: translateX(-6px);
  font-family: inherit;
}

.is-visible .pipe-nav-step {
  opacity: 1;
  transform: translateX(0);
  transition: background var(--motion-moderate), border-color var(--motion-moderate), box-shadow var(--motion-moderate), opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(0.15s + var(--i) * 0.06s);
}

.pipe-nav-step:hover {
  background: var(--color-bg-surface);
  transition-delay: 0s;
}

.pipe-nav-step.is-active {
  background: var(--color-bg-surface);
  border-color: color-mix(in oklab, var(--step-color, var(--color-brand)) 30%, var(--color-border-default));
  box-shadow: 0 0 12px color-mix(in oklab, var(--step-color, var(--color-brand)) 10%, transparent);
}

.pipe-nav-num {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--color-bg-surface);
  border: 1.5px solid var(--color-border-default);
  font-size: 0.625rem;
  font-weight: 700;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
  transition: background var(--motion-moderate), border-color var(--motion-moderate), color var(--motion-moderate);
}

.pipe-nav-step.is-active .pipe-nav-num {
  background: color-mix(in oklab, var(--step-color, var(--color-brand)) 15%, var(--color-bg-surface));
  border-color: color-mix(in oklab, var(--step-color, var(--color-brand)) 40%, var(--color-border-default));
  color: var(--step-color, var(--color-brand));
}

.pipe-nav-step.is-past .pipe-nav-num {
  background: color-mix(in oklab, var(--color-success) 10%, var(--color-bg-surface));
  border-color: color-mix(in oklab, var(--color-success) 30%, var(--color-border-default));
  color: var(--color-success);
}

.pipe-nav-name {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--color-text-tertiary);
  transition: color var(--motion-moderate);
}

.pipe-nav-step.is-active .pipe-nav-name {
  color: var(--color-text-primary);
}

.pipe-nav-step.is-past .pipe-nav-name {
  color: var(--color-text-secondary);
}

/* Connector line between nav steps */
.pipe-nav-connector {
  position: absolute;
  right: -2px;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 14px;
  background: var(--color-border-subtle);
  border-radius: 2px;
  overflow: hidden;
}

.pipe-nav-connector-fill {
  position: absolute;
  inset: 0;
  background: var(--color-success);
  border-radius: 2px;
  transform: scaleY(0);
  transform-origin: top;
  transition: transform var(--motion-slow) var(--ease-spring);
}

.pipe-nav-connector-fill.is-filled {
  transform: scaleY(1);
}

@media (max-width: 600px) {
  .pipe-nav {
    gap: 2px;
  }
  .pipe-nav-name {
    display: none;
  }
  .pipe-nav-step {
    padding: 7px 10px;
  }
}

/* ── Detail panel ── */
.pipe-detail {
  margin-top: 8px;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .pipe-detail {
  opacity: 1;
  transform: translateY(0);
}

.pipe-detail-inner {
  display: grid;
  align-items: start;
}

.pipe-panel {
  grid-area: 1 / 1;
  border: 1px solid var(--color-border-default);
  border-radius: 10px;
  background: var(--color-bg-elevated);
  padding: 16px;
  position: relative;
  overflow: hidden;
  visibility: hidden;
  opacity: 0;
  transform: translateY(6px);
  transition: opacity var(--motion-moderate) var(--ease-spring), transform var(--motion-moderate) var(--ease-spring), visibility 0s var(--motion-moderate), border-color var(--motion-moderate), box-shadow var(--motion-moderate);
}

.pipe-panel.is-active {
  visibility: visible;
  opacity: 1;
  transform: translateY(0);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring), visibility 0s, border-color var(--motion-moderate), box-shadow var(--motion-moderate);
}

.pipe-panel::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.6;
}

.pipe-panel--accent::before { background: radial-gradient(ellipse at 20% 30%, rgba(212, 165, 116, 0.05) 0%, transparent 60%); }
.pipe-panel--info::before { background: radial-gradient(ellipse at 20% 30%, rgba(107, 143, 168, 0.05) 0%, transparent 60%); }
.pipe-panel--warning::before { background: radial-gradient(ellipse at 20% 30%, rgba(201, 165, 90, 0.05) 0%, transparent 60%); }
.pipe-panel--brand::before { background: radial-gradient(ellipse at 20% 30%, rgba(196, 120, 90, 0.05) 0%, transparent 60%); }
.pipe-panel--success::before { background: radial-gradient(ellipse at 20% 30%, rgba(122, 155, 110, 0.05) 0%, transparent 60%); }

.pipe-panel--accent { border-color: color-mix(in oklab, var(--color-accent) 20%, var(--color-border-default)); }
.pipe-panel--info { border-color: color-mix(in oklab, var(--color-info) 20%, var(--color-border-default)); }
.pipe-panel--warning { border-color: color-mix(in oklab, var(--color-warning) 20%, var(--color-border-default)); }
.pipe-panel--brand { border-color: color-mix(in oklab, var(--color-brand) 20%, var(--color-border-default)); }
.pipe-panel--success { border-color: color-mix(in oklab, var(--color-success) 20%, var(--color-border-default)); }

.pipe-panel.is-active:hover {
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12);
}

/* Panel header */
.pipe-panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  position: relative;
}

.pipe-panel-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  flex-shrink: 0;
  transition: box-shadow var(--motion-moderate);
}

.pipe-panel-icon--accent { background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface)); color: var(--color-accent); }
.pipe-panel-icon--info { background: color-mix(in oklab, var(--color-info) 12%, var(--color-bg-surface)); color: var(--color-info); }
.pipe-panel-icon--warning { background: color-mix(in oklab, var(--color-warning) 12%, var(--color-bg-surface)); color: var(--color-warning); }
.pipe-panel-icon--brand { background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface)); color: var(--color-brand); }
.pipe-panel-icon--success { background: color-mix(in oklab, var(--color-success) 12%, var(--color-bg-surface)); color: var(--color-success); }

.pipe-panel:hover .pipe-panel-icon {
  box-shadow: 0 0 10px rgba(196, 120, 90, 0.1);
}

.pipe-panel-title-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.pipe-panel-title {
  font-weight: 600;
  font-size: 0.9375rem;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
}

.pipe-panel-subtitle {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

/* Panel body */
.pipe-panel-body {
  position: relative;
  margin-bottom: 12px;
}

/* Step 1: Sources */
.pipe-sources {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}

@media (max-width: 480px) {
  .pipe-sources {
    grid-template-columns: 1fr;
  }
}

.pipe-source {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  transition: border-color var(--motion-moderate);
}

.pipe-source:hover {
  border-color: var(--color-border-default);
}

.pipe-source svg {
  color: var(--color-accent-muted);
  flex-shrink: 0;
}

.pipe-source span {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}

/* Step 2: Intent tags */
.pipe-intents {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pipe-intent {
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 500;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  color: var(--color-text-tertiary);
  transition: all var(--motion-moderate);
}

.pipe-intent.is-active {
  background: color-mix(in oklab, var(--color-info) 10%, var(--color-bg-surface));
  border-color: color-mix(in oklab, var(--color-info) 30%, var(--color-border-default));
  color: var(--color-info);
  font-weight: 600;
}

/* Step 3: Action items */
.pipe-actions-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pipe-action-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  transition: border-color var(--motion-moderate);
}

.pipe-action-item:hover {
  border-color: var(--color-border-default);
}

.pipe-action-num {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: color-mix(in oklab, var(--color-warning) 12%, var(--color-bg-elevated));
  font-size: 0.5625rem;
  font-weight: 700;
  color: var(--color-warning);
  flex-shrink: 0;
}

.pipe-action-label {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  flex: 1;
}

.pipe-action-type {
  font-size: 0.625rem;
  font-family: var(--font-mono);
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
}

.pipe-action-type--api {
  background: color-mix(in oklab, var(--color-info) 10%, var(--color-bg-elevated));
  color: var(--color-info);
}

.pipe-action-type--draft {
  background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-elevated));
  color: var(--color-brand);
}

.pipe-action-type--data {
  background: color-mix(in oklab, var(--color-accent) 10%, var(--color-bg-elevated));
  color: var(--color-accent);
}

/* Step 4: Draft preview */
.pipe-draft {
  border-radius: 8px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  overflow: hidden;
}

.pipe-draft-header {
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-bg-soft);
}

.pipe-draft-subject {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.pipe-draft-body {
  padding: 10px 12px;
  display: flex;
  align-items: baseline;
  gap: 0;
}

.pipe-draft-preview {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.pipe-draft-cursor {
  display: inline-block;
  width: 2px;
  height: 13px;
  background: var(--color-brand);
  margin-left: 1px;
  vertical-align: text-bottom;
  border-radius: 1px;
}

.is-visible .pipe-draft-cursor {
  animation: cursor-blink 1s step-end infinite;
}

@keyframes cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* Step 5: Routing options */
.pipe-routes {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

@media (max-width: 480px) {
  .pipe-routes {
    grid-template-columns: 1fr;
  }
}

.pipe-route {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border-radius: 7px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  transition: border-color var(--motion-moderate), background var(--motion-moderate);
}

.pipe-route:hover {
  border-color: var(--color-border-default);
}

.pipe-route.is-primary {
  border-color: color-mix(in oklab, var(--color-success) 25%, var(--color-border-default));
  background: color-mix(in oklab, var(--color-success) 4%, var(--color-bg-surface));
}

.pipe-route-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.pipe-route.is-primary .pipe-route-label {
  color: var(--color-success);
}

.pipe-route-desc {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
}

/* ── Example line (bottom of each panel) ── */
.pipe-panel-example {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--color-border-subtle);
  position: relative;
}

.pipe-panel-example svg {
  color: var(--color-brand-dim);
  flex-shrink: 0;
  margin-top: 1px;
}

.pipe-panel-example span {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  line-height: 1.5;
}


</style>
