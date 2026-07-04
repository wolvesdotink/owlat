<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const layers = [
  {
    abbr: 'SPF',
    name: 'Sender Policy Framework',
    color: 'info',
    question: 'Is this server allowed to send email for this domain?',
    how: 'The domain publishes a DNS TXT record listing IP addresses and services authorized to send on its behalf. The receiving server checks the connecting IP against that list.',
    checks: 'Return-Path (envelope sender) domain',
    record: 'v=spf1 include:amazonses.com include:_spf.google.com ~all',
    verdicts: ['Pass', 'Fail', 'SoftFail', 'Neutral'],
    icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01',
  },
  {
    abbr: 'DKIM',
    name: 'DomainKeys Identified Mail',
    color: 'accent',
    question: 'Has the message been tampered with in transit?',
    how: 'The sending server signs specific headers and the body with a private key. The signature is added as a DKIM-Signature header. The recipient looks up the public key via DNS to verify.',
    checks: 'DKIM-Signature header (d= domain, s= selector)',
    record: 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEB...',
    verdicts: ['Pass', 'Fail'],
    icon: 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z',
  },
  {
    abbr: 'DMARC',
    name: 'Domain-based Message Authentication, Reporting & Conformance',
    color: 'success',
    question: 'Does the visible From domain align with SPF or DKIM — and what should happen if it doesn\'t?',
    how: 'Builds on SPF and DKIM by requiring that at least one of them passes AND aligns with the From header domain. The domain owner publishes a policy telling receivers what to do with failures.',
    checks: 'From header domain alignment with SPF and/or DKIM',
    record: 'v=DMARC1; p=reject; rua=mailto:dmarc-reports@example.com',
    verdicts: ['Pass', 'Fail'],
    policies: ['none (monitor)', 'quarantine (spam folder)', 'reject (drop)'],
    icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
  },
]
</script>

<template>
  <div class="ea" :class="{ 'is-visible': visible }">
    <template v-for="(layer, i) in layers" :key="layer.abbr">
      <!-- Auth layer card -->
      <div
        class="ea-layer"
        :class="`ea-layer--${layer.color}`"
        :style="{ '--s': i * 2 }"
      >
        <div class="ea-layer-header">
          <div class="ea-badge" :class="`ea-badge--${layer.color}`">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="layer.icon" /></svg>
          </div>
          <span class="ea-abbr">{{ layer.abbr }}</span>
          <span class="ea-name">{{ layer.name }}</span>
        </div>

        <div class="ea-question">{{ layer.question }}</div>

        <div class="ea-grid">
          <div class="ea-cell">
            <span class="ea-cell-label">How it works</span>
            <span class="ea-cell-value">{{ layer.how }}</span>
          </div>
          <div class="ea-cell">
            <span class="ea-cell-label">What it checks</span>
            <span class="ea-cell-value">{{ layer.checks }}</span>
          </div>
        </div>

        <div class="ea-record">
          <span class="ea-record-label">DNS Record</span>
          <code class="ea-record-code">{{ layer.record }}</code>
        </div>

        <div class="ea-verdicts">
          <span class="ea-verdict-label">Verdicts</span>
          <div class="ea-verdict-pills">
            <span v-for="v in layer.verdicts" :key="v" class="ea-verdict" :class="`ea-verdict--${layer.color}`">{{ v }}</span>
          </div>
        </div>

        <div v-if="layer.policies" class="ea-verdicts">
          <span class="ea-verdict-label">Policies</span>
          <div class="ea-verdict-pills">
            <span v-for="p in layer.policies" :key="p" class="ea-verdict ea-verdict--policy">{{ p }}</span>
          </div>
        </div>
      </div>

      <!-- Connector between layers -->
      <div v-if="i < layers.length - 1" class="ea-conn" :style="{ '--s': i * 2 + 1 }">
        <div class="ea-conn-line" />
        <div class="ea-conn-badge">
          <span>{{ i === 0 ? '+' : '=' }}</span>
        </div>
        <div class="ea-conn-line" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.ea {
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

/* Layer card */
.ea-layer {
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
  padding: 16px 18px;
  background: var(--color-bg-elevated);
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateY(14px);
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring), border-color var(--motion-moderate), box-shadow var(--motion-moderate);
  transition-delay: calc(var(--s) * 0.12s);
}

.is-visible .ea-layer {
  opacity: 1;
  transform: translateY(0);
}

.ea-layer:hover {
  border-color: var(--color-border-strong);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  transition-delay: 0s;
}

/* Header */
.ea-layer-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.ea-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  flex-shrink: 0;
}

.ea-badge--info {
  background: color-mix(in oklab, var(--color-info) 12%, var(--color-bg-surface));
  color: var(--color-info);
}

.ea-badge--accent {
  background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface));
  color: var(--color-accent);
}

.ea-badge--success {
  background: color-mix(in oklab, var(--color-success) 12%, var(--color-bg-surface));
  color: var(--color-success);
}

.ea-abbr {
  font-weight: 700;
  font-size: 0.9375rem;
  color: var(--color-text-primary);
  font-family: var(--font-mono);
}

.ea-name {
  font-size: 0.75rem;
  color: var(--color-text-tertiary);
}

/* Question */
.ea-question {
  font-size: 0.875rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
  margin-bottom: 12px;
  font-style: italic;
}

/* Grid */
.ea-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 12px;
}

@media (max-width: 580px) {
  .ea-grid {
    grid-template-columns: 1fr;
  }
}

.ea-cell {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ea-cell-label {
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-tertiary);
}

.ea-cell-value {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

/* DNS record */
.ea-record {
  margin-bottom: 10px;
}

.ea-record-label {
  display: block;
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-tertiary);
  margin-bottom: 4px;
}

.ea-record-code {
  display: block;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--color-bg-soft);
  border: 1px solid var(--color-border-subtle);
  font-size: 0.6875rem;
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
  overflow-x: auto;
  white-space: nowrap;
}

/* Verdicts */
.ea-verdicts {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.ea-verdicts:last-child {
  margin-bottom: 0;
}

.ea-verdict-label {
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

.ea-verdict-pills {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.ea-verdict {
  padding: 2px 10px;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-family: var(--font-mono);
  border: 1px solid var(--color-border-subtle);
}

.ea-verdict--info {
  color: var(--color-info);
  background: color-mix(in oklab, var(--color-info) 6%, var(--color-bg-surface));
}

.ea-verdict--accent {
  color: var(--color-accent);
  background: color-mix(in oklab, var(--color-accent) 6%, var(--color-bg-surface));
}

.ea-verdict--success {
  color: var(--color-success);
  background: color-mix(in oklab, var(--color-success) 6%, var(--color-bg-surface));
}

.ea-verdict--policy {
  color: var(--color-text-secondary);
  background: var(--color-bg-surface);
}

/* Connector */
.ea-conn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  padding: 2px 0;
  opacity: 0;
  transition: opacity var(--motion-slow) var(--ease-spring);
  transition-delay: calc(var(--s) * 0.12s + 0.1s);
}

.is-visible .ea-conn {
  opacity: 1;
}

.ea-conn-line {
  width: 2px;
  height: 10px;
  background: var(--color-border-strong);
  border-radius: 1px;
}

.ea-conn-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-default);
}

.ea-conn-badge span {
  font-size: 0.8125rem;
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--color-text-tertiary);
}

</style>
