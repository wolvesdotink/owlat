<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const frontendLayer = {
  label: 'Frontend',
  tech: 'Nuxt 4 + Vue 3',
  color: 'brand',
  items: [
    { name: 'Pages', detail: 'Router', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1' },
    { name: 'Composables', detail: 'State', icon: 'M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7c0-2-1-3-3-3H7C5 4 4 5 4 7zm4 3h8m-8 4h5' },
    { name: 'Component Library', detail: 'UI Components', icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },
  ],
}

const backendLayer = {
  label: 'Convex Backend',
  tech: 'Serverless',
  color: 'accent',
  items: [
    { name: 'Queries', detail: 'Real-time', icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z' },
    { name: 'Mutations', detail: 'ACID', icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z' },
    { name: 'Actions', detail: 'External APIs', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
  ],
  items2: [
    { name: 'Schema', detail: 'Database', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4' },
    { name: 'BetterAuth', detail: 'Auth', icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z' },
    { name: 'HTTP Handlers', detail: 'REST API', icon: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z' },
  ],
}

const primaryEmail = {
  name: 'Owlat MTA',
  detail: 'Default — Direct SMTP delivery',
  icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  features: ['Intelligence pipeline', 'IP warming', 'Bounce processing'],
}

const altProviders = [
  { name: 'AWS SES', detail: 'Alternative', icon: 'M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z' },
  { name: 'Resend', detail: 'Alternative', icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
]

const webhooks = { name: 'Webhooks', detail: 'Events', icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1' }

const analytics = { name: 'PostHog', detail: 'Analytics & Errors', lines: ['Client (posthog-js)', 'Server (posthog-node)'] }
</script>

<template>
  <div class="arch-system" :class="{ 'is-visible': visible }">
    <!-- Frontend layer -->
    <div class="arch-layer arch-layer--brand" :style="{ '--stagger': 0 }">
      <div class="arch-layer-header">
        <span class="arch-layer-label">{{ frontendLayer.label }}</span>
        <span class="arch-layer-tech">{{ frontendLayer.tech }}</span>
      </div>
      <div class="arch-layer-items">
        <div
          v-for="(item, ii) in frontendLayer.items"
          :key="item.name"
          class="arch-item"
          :style="{ '--item-stagger': ii }"
        >
          <div class="arch-item-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="item.icon" /></svg>
          </div>
          <div class="arch-item-text">
            <span class="arch-item-name">{{ item.name }}</span>
            <span class="arch-item-detail">{{ item.detail }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Connector between frontend and backend -->
    <div class="arch-connector" :style="{ '--stagger': 1 }">
      <div class="arch-connector-line" />
      <div class="arch-connector-labels">
        <span>Real-time subscriptions</span>
        <span>Mutations / Actions</span>
      </div>
      <div class="arch-connector-line" />
    </div>

    <!-- Convex Backend layer -->
    <div class="arch-layer arch-layer--accent" :style="{ '--stagger': 1 }">
      <div class="arch-layer-header">
        <span class="arch-layer-label">{{ backendLayer.label }}</span>
        <span class="arch-layer-tech">{{ backendLayer.tech }}</span>
      </div>
      <div class="arch-layer-items">
        <div
          v-for="(item, ii) in backendLayer.items"
          :key="item.name"
          class="arch-item"
          :style="{ '--item-stagger': 3 + ii }"
        >
          <div class="arch-item-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="item.icon" /></svg>
          </div>
          <div class="arch-item-text">
            <span class="arch-item-name">{{ item.name }}</span>
            <span class="arch-item-detail">{{ item.detail }}</span>
          </div>
        </div>
      </div>
      <div class="arch-layer-items arch-layer-items--row2">
        <div
          v-for="(item, ii) in backendLayer.items2"
          :key="item.name"
          class="arch-item"
          :style="{ '--item-stagger': 6 + ii }"
        >
          <div class="arch-item-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="item.icon" /></svg>
          </div>
          <div class="arch-item-text">
            <span class="arch-item-name">{{ item.name }}</span>
            <span class="arch-item-detail">{{ item.detail }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Connector between backend and externals -->
    <div class="arch-connector" :style="{ '--stagger': 2 }">
      <div class="arch-connector-line" />
      <div class="arch-connector-fork">
        <div class="arch-fork-bar" />
        <div class="arch-fork-branches">
          <div class="arch-fork-line" />
          <div class="arch-fork-line" />
        </div>
      </div>
    </div>

    <!-- Email delivery + Webhooks row -->
    <div class="arch-delivery-row" :style="{ '--stagger': 3 }">
      <!-- Primary MTA -->
      <div class="arch-primary-provider" :style="{ '--item-stagger': 9 }">
        <div class="arch-primary-provider-header">
          <div class="arch-item-icon arch-item-icon--primary">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="primaryEmail.icon" /></svg>
          </div>
          <div class="arch-primary-provider-text">
            <span class="arch-item-name">{{ primaryEmail.name }}</span>
            <span class="arch-item-detail">{{ primaryEmail.detail }}</span>
          </div>
        </div>
        <div class="arch-primary-provider-features">
          <span v-for="feat in primaryEmail.features" :key="feat" class="arch-feature-tag">{{ feat }}</span>
        </div>
        <div class="arch-alt-providers">
          <span class="arch-alt-label">or</span>
          <div
            v-for="alt in altProviders"
            :key="alt.name"
            class="arch-alt-provider"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="alt.icon" /></svg>
            <span>{{ alt.name }}</span>
          </div>
        </div>
      </div>

      <!-- Webhooks -->
      <div class="arch-external arch-external--webhooks" :style="{ '--item-stagger': 10 }">
        <div class="arch-item-icon arch-item-icon--ext">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="webhooks.icon" /></svg>
        </div>
        <span class="arch-item-name">{{ webhooks.name }}</span>
        <span class="arch-item-detail">{{ webhooks.detail }}</span>
      </div>
    </div>

    <!-- Analytics block -->
    <div class="arch-analytics" :style="{ '--stagger': 4 }">
      <div class="arch-analytics-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
      </div>
      <div class="arch-analytics-text">
        <span class="arch-analytics-name">{{ analytics.name }}</span>
        <span class="arch-analytics-detail">{{ analytics.detail }}</span>
      </div>
      <div class="arch-analytics-lines">
        <span v-for="line in analytics.lines" :key="line" class="arch-analytics-line">← {{ line }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.arch-system {
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  align-items: stretch;
}

/* ── Layers ── */
.arch-layer {
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
  padding: 16px;
  background: var(--color-bg-elevated);
  opacity: 0;
  transform: translateY(16px);
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring), border-color var(--motion-moderate), box-shadow var(--motion-moderate);
  transition-delay: calc(var(--stagger) * 0.15s);
  position: relative;
  overflow: hidden;
}

.arch-layer::before {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity var(--motion-slow);
  pointer-events: none;
}

.arch-layer--brand::before {
  background: radial-gradient(ellipse at 30% 20%, rgba(196, 120, 90, 0.06) 0%, transparent 70%);
}

.arch-layer--accent::before {
  background: radial-gradient(ellipse at 70% 80%, rgba(212, 165, 116, 0.05) 0%, transparent 70%);
}

.arch-layer:hover::before {
  opacity: 1;
}

.arch-layer:hover {
  border-color: var(--color-border-strong);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
  transition-delay: 0s;
}

.is-visible .arch-layer {
  opacity: 1;
  transform: translateY(0);
}

.arch-layer-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.arch-layer-label {
  font-weight: var(--font-weight-semibold);
  font-size: 0.9375rem;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
}

.arch-layer--brand .arch-layer-label { color: var(--color-brand); }
.arch-layer--accent .arch-layer-label { color: var(--color-accent); }

.arch-layer-tech {
  font-size: 0.75rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

/* ── Items grid ── */
.arch-layer-items {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.arch-layer-items--row2 {
  margin-top: 10px;
}

@media (max-width: 580px) {
  .arch-layer-items {
    grid-template-columns: 1fr;
  }
}

.arch-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  border: 1px solid transparent;
  transition: border-color var(--motion-moderate), background var(--motion-moderate), transform var(--motion-moderate) var(--ease-spring);
  opacity: 0;
  transform: translateY(10px) scale(0.97);
  cursor: default;
}

.is-visible .arch-item {
  opacity: 1;
  transform: translateY(0) scale(1);
  transition: border-color var(--motion-moderate), background var(--motion-moderate), transform var(--motion-moderate) var(--ease-spring), opacity var(--motion-slow) var(--ease-spring);
  transition-delay: calc(0.2s + var(--item-stagger) * 0.06s);
}

.arch-item:hover {
  border-color: var(--color-border-default);
  background: var(--color-bg-surface-hover);
  transform: translateY(-1px) scale(1.01);
  transition-delay: 0s;
}

.arch-item-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--color-bg-elevated);
  color: var(--color-brand);
  flex-shrink: 0;
  transition: color var(--motion-moderate), box-shadow var(--motion-moderate);
}

.arch-layer--accent .arch-item-icon {
  color: var(--color-accent);
}

.arch-item:hover .arch-item-icon {
  box-shadow: 0 0 12px rgba(196, 120, 90, 0.15);
}

.arch-item-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.arch-item-name {
  font-weight: var(--font-weight-semibold);
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  white-space: nowrap;
}

.arch-item-detail {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

/* ── Connectors ── */
.arch-connector {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  padding: 4px 0;
  opacity: 0;
  transition: opacity var(--motion-slow) var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.15s + 0.1s);
}

.is-visible .arch-connector {
  opacity: 1;
}

.arch-connector-line {
  width: 2px;
  height: 16px;
  background: var(--color-border-strong);
  border-radius: 1px;
  position: relative;
}

.is-visible .arch-connector-line {
  animation: line-draw 0.6s var(--ease-spring) both;
  animation-delay: calc(var(--stagger) * 0.15s + 0.3s);
}

@keyframes line-draw {
  from { transform: scaleY(0); }
  to { transform: scaleY(1); }
}

.arch-connector-labels {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 14px;
  background: var(--color-bg-surface);
  border-radius: 6px;
  border: 1px solid var(--color-border-subtle);
}

.arch-connector-labels span {
  font-size: 0.6875rem;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  white-space: nowrap;
}

.arch-connector-fork {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 80%;
  max-width: 400px;
}

.arch-fork-bar {
  width: 100%;
  height: 2px;
  background: var(--color-border-strong);
  border-radius: 1px;
}

.arch-fork-branches {
  display: flex;
  justify-content: space-between;
  width: 100%;
}

.arch-fork-line {
  width: 2px;
  height: 12px;
  background: var(--color-border-strong);
  border-radius: 1px;
}

/* ── Delivery row ── */
.arch-delivery-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  opacity: 0;
  transform: translateY(12px);
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.15s);
}

.is-visible .arch-delivery-row {
  opacity: 1;
  transform: translateY(0);
}

@media (max-width: 580px) {
  .arch-delivery-row {
    grid-template-columns: 1fr;
  }
}

/* ── Primary provider (MTA) ── */
.arch-primary-provider {
  padding: 16px;
  border-radius: 12px;
  border: 1px solid color-mix(in oklab, var(--color-brand) 30%, var(--color-border-default));
  background: var(--color-bg-elevated);
  transition: border-color var(--motion-moderate), transform var(--motion-moderate) var(--ease-spring), box-shadow var(--motion-moderate);
  opacity: 0;
  transform: translateY(10px);
  position: relative;
  overflow: hidden;
}

.arch-primary-provider::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 20% 30%, rgba(196, 120, 90, 0.06) 0%, transparent 70%);
  pointer-events: none;
}

.is-visible .arch-primary-provider {
  opacity: 1;
  transform: translateY(0);
  transition-delay: calc(0.3s + var(--item-stagger) * 0.08s);
}

.arch-primary-provider:hover {
  border-color: color-mix(in oklab, var(--color-brand) 50%, var(--color-border-default));
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
  transition-delay: 0s;
}

.arch-primary-provider-header {
  display: flex;
  align-items: center;
  gap: 12px;
  position: relative;
}

.arch-item-icon--primary {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
  color: var(--color-brand);
  flex-shrink: 0;
}

.arch-primary-provider-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.arch-primary-provider-text .arch-item-name {
  font-size: 0.875rem;
}

.arch-primary-provider-features {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
  position: relative;
}

.arch-feature-tag {
  font-size: 0.6875rem;
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
  background: var(--color-bg-surface);
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid var(--color-border-subtle);
  white-space: nowrap;
}

.arch-alt-providers {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--color-border-subtle);
  position: relative;
}

.arch-alt-label {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-style: italic;
}

.arch-alt-provider {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.75rem;
  color: var(--color-text-tertiary);
  padding: 3px 10px;
  border-radius: 6px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  transition: color var(--motion-moderate), border-color var(--motion-moderate);
}

.arch-alt-provider:hover {
  color: var(--color-text-secondary);
  border-color: var(--color-border-default);
}

.arch-alt-provider svg {
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

/* ── External services (webhooks) ── */
.arch-external {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 14px 20px;
  border-radius: 10px;
  border: 1px solid var(--color-border-default);
  background: var(--color-bg-elevated);
  text-align: center;
  transition: border-color var(--motion-moderate), transform var(--motion-moderate) var(--ease-spring), box-shadow var(--motion-moderate);
  opacity: 0;
  transform: translateY(10px);
}

.is-visible .arch-external {
  opacity: 1;
  transform: translateY(0);
  transition-delay: calc(0.3s + var(--item-stagger) * 0.08s);
}

.arch-external:hover {
  border-color: color-mix(in oklab, var(--color-brand) 40%, var(--color-border-default));
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
  transition-delay: 0s;
}

.arch-item-icon--ext {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--color-bg-surface);
  margin-bottom: 2px;
}

/* ── Analytics ── */
.arch-analytics {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 16px;
  padding: 14px 18px;
  border-radius: 10px;
  border: 1px dashed var(--color-border-default);
  background: var(--color-bg-soft);
  opacity: 0;
  transform: translateY(12px);
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring), border-color var(--motion-moderate);
  transition-delay: calc(var(--stagger) * 0.15s);
}

.is-visible .arch-analytics {
  opacity: 1;
  transform: translateY(0);
}

.arch-analytics:hover {
  border-color: color-mix(in oklab, var(--color-info) 40%, var(--color-border-default));
}

.arch-analytics-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--color-info-subtle);
  color: var(--color-info);
  flex-shrink: 0;
}

.arch-analytics-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.arch-analytics-name {
  font-weight: var(--font-weight-semibold);
  font-size: 0.875rem;
  color: var(--color-text-primary);
}

.arch-analytics-detail {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}

.arch-analytics-lines {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-left: auto;
}

.arch-analytics-line {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  white-space: nowrap;
}





</style>
