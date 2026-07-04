<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const builderItems = [
  { name: 'Inline Editor', icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z' },
  { name: 'Blocks (JSON)', icon: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2z' },
  { name: 'Saved Blocks', icon: 'M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z' },
]

const defaultProvider = {
  name: 'Owlat MTA',
  detail: 'Direct SMTP · Intelligence pipeline · IP warming',
  icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2',
}

const alternativeProviders = [
  {
    name: 'Resend',
    detail: 'Optional',
    icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  },
  {
    name: 'AWS SES',
    detail: 'Optional',
    icon: 'M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z',
  },
]

const sesFeatures = [
  'Domain registration (VerifyDomainIdentity/DKIM)',
  'MAIL FROM configuration',
  'Verification status polling',
]

const pipelineFeatures = [
  { label: 'DKIM signing', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
  { label: 'MX delivery', icon: 'M12 19l9 2-9-18-9 18 9-2zm0 0v-8' },
  { label: 'IP warming', icon: 'M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z' },
  { label: 'Rate limiting', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
  { label: 'Health-aware failover', icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15' },
]
</script>

<template>
  <div class="arch-email" :class="{ 'is-visible': visible }">

    <!-- Email Builder -->
    <div class="email-section email-section--builder" :style="{ '--s': 0 }">
      <div class="email-section-header">
        <div class="email-section-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
        </div>
        <span class="email-section-label">Email Builder</span>
      </div>
      <div class="email-items">
        <div
          v-for="(item, i) in builderItems"
          :key="item.name"
          class="email-item"
          :style="{ '--i': i }"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="item.icon" /></svg>
          <span>{{ item.name }}</span>
        </div>
      </div>
    </div>

    <!-- Connector: Builder → Rendering -->
    <div class="email-connector" :style="{ '--s': 1 }">
      <div class="email-connector-line" />
      <div class="email-connector-badge">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14l-7 7m0 0l-7-7m7 7V3" /></svg>
      </div>
      <div class="email-connector-line" />
    </div>

    <!-- Email Rendering -->
    <div class="email-section email-section--rendering" :style="{ '--s': 2 }">
      <div class="email-section-header">
        <div class="email-section-icon email-section-icon--accent">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
        </div>
        <span class="email-section-label">Email Rendering</span>
      </div>
      <div class="email-pipeline">
        <span class="email-pipeline-step">JSON Blocks</span>
        <svg class="email-pipeline-arrow" width="20" height="12" viewBox="0 0 20 12" fill="none">
          <path d="M1 6h16m0 0l-4-4m4 4l-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="email-pipeline-step email-pipeline-step--brand">@owlat/email-renderer</span>
        <svg class="email-pipeline-arrow" width="20" height="12" viewBox="0 0 20 12" fill="none">
          <path d="M1 6h16m0 0l-4-4m4 4l-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="email-pipeline-step email-pipeline-step--success">HTML Email</span>
      </div>
      <div class="email-tags">
        <span class="email-tag">Responsive layouts</span>
        <span class="email-tag">Cross-client compatibility</span>
      </div>
    </div>

    <!-- Connector: Rendering → Providers -->
    <div class="email-connector" :style="{ '--s': 3 }">
      <div class="email-connector-line" />
      <div class="email-connector-badge">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14l-7 7m0 0l-7-7m7 7V3" /></svg>
      </div>
      <div class="email-connector-line" />
    </div>

    <!-- Email Providers -->
    <div class="email-section email-section--providers" :style="{ '--s': 4 }">
      <div class="email-section-header">
        <div class="email-section-icon email-section-icon--info">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
        </div>
        <span class="email-section-label">Email Delivery</span>
      </div>

      <!-- Default provider (MTA) -->
      <div class="email-provider email-provider--default" :style="{ '--i': 6 }">
        <div class="email-provider-icon email-provider-icon--brand">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="defaultProvider.icon" /></svg>
        </div>
        <div class="email-provider-text">
          <span class="email-provider-name">{{ defaultProvider.name }}</span>
          <span class="email-provider-detail">{{ defaultProvider.detail }}</span>
        </div>
        <span class="email-provider-badge">Default</span>
      </div>

      <!-- Alternative providers -->
      <div class="email-alt-label" :style="{ '--i': 7 }">Optional alternatives</div>
      <div class="email-providers">
        <div
          v-for="(prov, i) in alternativeProviders"
          :key="prov.name"
          class="email-provider"
          :style="{ '--i': i + 8 }"
        >
          <div class="email-provider-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="prov.icon" /></svg>
          </div>
          <div class="email-provider-text">
            <span class="email-provider-name">{{ prov.name }}</span>
            <span class="email-provider-detail">{{ prov.detail }}</span>
          </div>
        </div>
      </div>

      <!-- SES Identity Manager -->
      <div class="email-ses" :style="{ '--i': 10 }">
        <div class="email-ses-header">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
          <span>SES Identity Manager</span>
          <code>sesIdentity.ts</code>
        </div>
        <ul class="email-ses-features">
          <li v-for="feat in sesFeatures" :key="feat">{{ feat }}</li>
        </ul>
      </div>

      <!-- Pipeline features -->
      <div class="email-pipeline-features">
        <code class="email-fn-name">resolveRoute() → getProviderByType()</code>
        <div class="email-pipeline-tags">
          <div
            v-for="(feat, i) in pipelineFeatures"
            :key="feat.label"
            class="email-pipeline-tag"
            :style="{ '--i': i + 10 }"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="feat.icon" /></svg>
            <span>{{ feat.label }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.arch-email {
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

/* ── Sections ── */
.email-section {
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
  padding: 16px 18px;
  background: var(--color-bg-elevated);
  opacity: 0;
  transform: translateY(14px);
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring), border-color var(--motion-moderate), box-shadow var(--motion-moderate);
  transition-delay: calc(var(--s) * 0.12s);
  position: relative;
  overflow: hidden;
}

.is-visible .email-section {
  opacity: 1;
  transform: translateY(0);
}

.email-section:hover {
  border-color: var(--color-border-strong);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.email-section-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.email-section-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
  color: var(--color-brand);
}

.email-section-icon--accent {
  background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface));
  color: var(--color-accent);
}

.email-section-icon--info {
  background: color-mix(in oklab, var(--color-info) 12%, var(--color-bg-surface));
  color: var(--color-info);
}

.email-section-label {
  font-weight: 600;
  font-size: 0.9375rem;
  color: var(--color-text-primary);
}

/* ── Builder items ── */
.email-items {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

@media (max-width: 580px) {
  .email-items {
    grid-template-columns: 1fr;
  }
}

.email-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-text-primary);
  border: 1px solid transparent;
  transition: border-color var(--motion-moderate), background var(--motion-moderate), transform var(--motion-moderate) var(--ease-spring);
  opacity: 0;
  transform: translateY(8px);
}

.email-item svg {
  color: var(--color-brand-muted);
  flex-shrink: 0;
}

.is-visible .email-item {
  opacity: 1;
  transform: translateY(0);
  transition-delay: calc(0.1s + var(--i) * 0.07s);
}

.email-item:hover {
  border-color: var(--color-border-default);
  background: var(--color-bg-surface-hover);
  transform: translateY(-1px);
  transition-delay: 0s;
}

/* ── Rendering pipeline ── */
.email-pipeline {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.email-pipeline-step {
  padding: 6px 12px;
  border-radius: 6px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
  white-space: nowrap;
  transition: border-color var(--motion-moderate), color var(--motion-moderate);
}

.email-pipeline-step--brand {
  border-color: var(--color-brand-dim);
  color: var(--color-brand);
  background: color-mix(in oklab, var(--color-brand) 6%, var(--color-bg-surface));
}

.email-pipeline-step--success {
  border-color: color-mix(in oklab, var(--color-success) 30%, var(--color-border-subtle));
  color: var(--color-success);
  background: color-mix(in oklab, var(--color-success) 6%, var(--color-bg-surface));
}

.email-pipeline-arrow {
  color: var(--color-text-disabled);
  flex-shrink: 0;
  transition: color var(--motion-moderate);
}

.email-section--rendering:hover .email-pipeline-arrow {
  color: var(--color-brand-dim);
}

.email-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.email-tag {
  padding: 3px 10px;
  border-radius: 9999px;
  background: var(--color-bg-soft);
  border: 1px solid var(--color-border-subtle);
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
}

/* ── Connectors ── */
.email-connector {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  padding: 2px 0;
  opacity: 0;
  transition: opacity var(--motion-slow) var(--ease-spring);
  transition-delay: calc(var(--s) * 0.12s + 0.1s);
}

.is-visible .email-connector {
  opacity: 1;
}

.email-connector-line {
  width: 2px;
  height: 10px;
  background: var(--color-border-strong);
  border-radius: 1px;
}

.email-connector-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-default);
  color: var(--color-text-tertiary);
  animation: connector-pulse 3s ease-in-out infinite;
}

@keyframes connector-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(196, 120, 90, 0); }
  50% { box-shadow: 0 0 8px 2px rgba(196, 120, 90, 0.1); }
}

/* ── Default provider card ── */
.email-provider--default {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--color-brand) 6%, var(--color-bg-surface));
  border: 1px solid var(--color-brand-dim);
  margin-bottom: 12px;
  opacity: 0;
  transform: translateY(8px);
  transition: border-color var(--motion-moderate), transform var(--motion-moderate) var(--ease-spring), background var(--motion-moderate), opacity var(--motion-slow) var(--ease-spring);
}

.is-visible .email-provider--default {
  opacity: 1;
  transform: translateY(0);
  transition-delay: calc(0.15s + var(--i) * 0.07s);
}

.email-provider--default:hover {
  border-color: var(--color-brand);
  transform: translateY(-1px);
  transition-delay: 0s;
}

.email-provider-icon--brand {
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
  color: var(--color-brand);
}

.email-provider-badge {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 9999px;
  background: color-mix(in oklab, var(--color-brand) 15%, var(--color-bg-surface));
  color: var(--color-brand);
  font-size: 0.6875rem;
  font-weight: 600;
  flex-shrink: 0;
}

.email-alt-label {
  font-size: 0.6875rem;
  font-weight: 500;
  color: var(--color-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
  opacity: 0;
  transition: opacity var(--motion-slow) var(--ease-spring);
}

.is-visible .email-alt-label {
  opacity: 1;
  transition-delay: calc(0.15s + var(--i) * 0.07s);
}

/* ── Providers ── */
.email-providers {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  margin-bottom: 12px;
}

@media (max-width: 580px) {
  .email-providers {
    grid-template-columns: 1fr;
  }
}

.email-provider {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  border: 1px solid transparent;
  transition: border-color var(--motion-moderate), transform var(--motion-moderate) var(--ease-spring), background var(--motion-moderate);
  opacity: 0;
  transform: translateY(8px);
}

.is-visible .email-provider {
  opacity: 1;
  transform: translateY(0);
  transition-delay: calc(0.15s + var(--i) * 0.07s);
}

.email-provider:hover {
  border-color: var(--color-border-default);
  background: var(--color-bg-surface-hover);
  transform: translateY(-1px);
  transition-delay: 0s;
}

.email-provider-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--color-bg-elevated);
  color: var(--color-info);
  flex-shrink: 0;
}

.email-provider-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.email-provider-name {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
}

.email-provider-detail {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
}

/* ── SES Identity Manager ── */
.email-ses {
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  border: 1px dashed var(--color-border-default);
  margin-bottom: 12px;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring), border-color var(--motion-moderate);
}

.is-visible .email-ses {
  opacity: 1;
  transform: translateY(0);
  transition-delay: calc(0.15s + var(--i) * 0.07s);
}

.email-ses:hover {
  border-color: color-mix(in oklab, var(--color-warning) 40%, var(--color-border-default));
}

.email-ses-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  margin-bottom: 8px;
}

.email-ses-header svg {
  color: var(--color-warning);
}

.email-ses-header code {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  padding: 2px 6px;
  background: var(--color-bg-elevated);
  border-radius: 4px;
  border: 1px solid var(--color-border-subtle);
  margin-left: auto;
}

.email-ses-features {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.email-ses-features li {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  padding-left: 16px;
  position: relative;
}

.email-ses-features li::before {
  content: '›';
  position: absolute;
  left: 4px;
  color: var(--color-warning);
  font-weight: 600;
}

/* ── Pipeline features ── */
.email-pipeline-features {
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--color-bg-soft);
  border: 1px solid var(--color-border-subtle);
}

.email-fn-name {
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--color-accent);
  margin-bottom: 10px;
  display: block;
}

.email-pipeline-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.email-pipeline-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 6px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  transition: border-color var(--motion-moderate), transform var(--motion-moderate) var(--ease-spring);
  opacity: 0;
}

.is-visible .email-pipeline-tag {
  opacity: 1;
  transition-delay: calc(0.2s + var(--i) * 0.06s);
}

.email-pipeline-tag svg {
  color: var(--color-info);
  flex-shrink: 0;
}

.email-pipeline-tag:hover {
  border-color: var(--color-border-default);
  transform: translateY(-1px);
  transition-delay: 0s;
}

/* ── Ambient animations ── */
.is-visible .email-pipeline-arrow {
}

.is-visible .email-pipeline-arrow:nth-child(4) {
  animation-delay: 0.5s;
}

</style>
