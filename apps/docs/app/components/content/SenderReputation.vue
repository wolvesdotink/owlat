<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const pillars = [
  {
    key: 'ip',
    title: 'IP Reputation',
    color: 'info',
    icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01',
    era: 'Legacy primary',
    what: 'A trust score assigned to each IP address based on the sending behavior observed from that address — bounce rates, complaint rates, spam trap hits, and volume patterns.',
    signal: 'The connecting server\'s IP address, checked against blocklists (Spamhaus, Barracuda) and the provider\'s own reputation database.',
    persistence: 'Tied to infrastructure. When you switch ESPs or rotate IPs, you start over. Shared IPs blend your reputation with other senders.',
  },
  {
    key: 'domain',
    title: 'Domain Reputation',
    color: 'brand',
    icon: 'M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9',
    era: 'Modern primary',
    what: 'A trust score assigned to your sending domain, primarily based on the DKIM signing domain (d=), but also the envelope sender domain and From header domain.',
    signal: 'DKIM signature domain, Return-Path domain, and From header domain — verified through DNS-based authentication records.',
    persistence: 'Travels with you. Switch ESPs, rotate IPs, migrate infrastructure — your domain reputation persists because it\'s tied to your DNS identity, not your server.',
  },
]

const timeline = [
  { year: 'Pre-2015', label: 'IP dominant', detail: 'DKIM/DMARC adoption low, IP was the most reliable sender identifier', position: 0, color: 'info' },
  { year: '2015–2023', label: 'Gradual shift', detail: 'Domain auth adoption grows, Gmail shifts to domain-based scoring', position: 1, color: 'accent' },
  { year: '2024+', label: 'Domain dominant', detail: 'Google & Yahoo enforce domain-level auth for bulk senders', position: 2, color: 'brand' },
]
</script>

<template>
  <div class="sr" :class="{ 'is-visible': visible }">
    <!-- Two pillar cards -->
    <div class="sr-pillars">
      <div
        v-for="(pillar, i) in pillars"
        :key="pillar.key"
        class="sr-card"
        :class="`sr-card--${pillar.color}`"
        :style="{ '--i': i }"
      >
        <!-- Header -->
        <div class="sr-card-header">
          <div class="sr-badge" :class="`sr-badge--${pillar.color}`">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="pillar.icon" /></svg>
          </div>
          <span class="sr-card-title">{{ pillar.title }}</span>
          <span class="sr-era" :class="`sr-era--${pillar.color}`">{{ pillar.era }}</span>
        </div>

        <!-- Info cells -->
        <div class="sr-cells">
          <div class="sr-cell">
            <span class="sr-cell-label">What it is</span>
            <span class="sr-cell-value">{{ pillar.what }}</span>
          </div>
          <div class="sr-cell">
            <span class="sr-cell-label">Trust signal</span>
            <span class="sr-cell-value">{{ pillar.signal }}</span>
          </div>
          <div class="sr-cell">
            <span class="sr-cell-label">Persistence</span>
            <span class="sr-cell-value">{{ pillar.persistence }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Timeline: the shift -->
    <div class="sr-timeline" :style="{ '--i': 2 }">
      <div class="sr-timeline-label">The shift over time</div>
      <div class="sr-timeline-track">
        <div class="sr-timeline-line" />
        <div
          v-for="(point, j) in timeline"
          :key="point.year"
          class="sr-timeline-point"
          :style="{ '--j': j }"
        >
          <div class="sr-timeline-dot" :class="`sr-timeline-dot--${point.color}`" />
          <div class="sr-timeline-content">
            <span class="sr-timeline-year">{{ point.year }}</span>
            <span class="sr-timeline-milestone">{{ point.label }}</span>
            <span class="sr-timeline-detail">{{ point.detail }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sr {
  margin: 2rem 0;
}

/* Pillar cards grid */
.sr-pillars {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
}

@media (max-width: 680px) {
  .sr-pillars {
    grid-template-columns: 1fr;
  }
}

/* Card */
.sr-card {
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
  padding: 16px 18px;
  background: var(--color-bg-elevated);
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateY(14px);
  transition: opacity 0.6s var(--ease-out-expo), transform 0.6s var(--ease-out-expo), border-color 0.3s, box-shadow 0.3s;
  transition-delay: calc(var(--i) * 0.15s);
}

.is-visible .sr-card {
  opacity: 1;
  transform: translateY(0);
}

.sr-card:hover {
  border-color: var(--color-border-strong);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  transition-delay: 0s;
}

/* Ambient shimmer */
.is-visible .sr-card {
  animation: sr-shimmer 4s ease-in-out infinite;
  animation-delay: calc(var(--i) * 0.6s);
}

@keyframes sr-shimmer {
  0%, 100% { border-color: var(--color-border-default); }
  50% { border-color: color-mix(in oklab, var(--color-brand) 14%, var(--color-border-default)); }
}

/* Card header */
.sr-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.sr-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  flex-shrink: 0;
}

.sr-badge--info {
  background: color-mix(in oklab, var(--color-info) 12%, var(--color-bg-surface));
  color: var(--color-info);
}

.sr-badge--brand {
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
  color: var(--color-brand);
}

.sr-card-title {
  font-weight: 700;
  font-size: 0.9375rem;
  color: var(--color-text-primary);
}

.sr-era {
  margin-left: auto;
  padding: 2px 10px;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-family: var(--font-mono);
  font-weight: 600;
  border: 1px solid var(--color-border-subtle);
}

.sr-era--info {
  color: var(--color-info);
  background: color-mix(in oklab, var(--color-info) 6%, var(--color-bg-surface));
}

.sr-era--brand {
  color: var(--color-brand);
  background: color-mix(in oklab, var(--color-brand) 6%, var(--color-bg-surface));
}

/* Cells */
.sr-cells {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sr-cell {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sr-cell-label {
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-tertiary);
}

.sr-cell-value {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

/* Timeline */
.sr-timeline {
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
  padding: 16px 18px;
  background: var(--color-bg-elevated);
  opacity: 0;
  transform: translateY(14px);
  transition: opacity 0.6s var(--ease-out-expo), transform 0.6s var(--ease-out-expo);
  transition-delay: calc(0.1s + var(--i) * 0.15s);
}

.is-visible .sr-timeline {
  opacity: 1;
  transform: translateY(0);
}

.sr-timeline-label {
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-tertiary);
  margin-bottom: 14px;
}

.sr-timeline-track {
  display: flex;
  align-items: flex-start;
  gap: 0;
  position: relative;
}

.sr-timeline-line {
  position: absolute;
  top: 9px;
  left: 9px;
  right: 9px;
  height: 2px;
  background: linear-gradient(to right, var(--color-info), var(--color-accent), var(--color-brand));
  border-radius: 1px;
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 0.8s var(--ease-out-expo);
  transition-delay: 0.4s;
}

.is-visible .sr-timeline-line {
  transform: scaleX(1);
}

.sr-timeline-point {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  z-index: 1;
  opacity: 0;
  transform: translateY(6px);
  transition: opacity 0.5s var(--ease-out-expo), transform 0.5s var(--ease-out-expo);
  transition-delay: calc(0.5s + var(--j) * 0.12s);
}

.is-visible .sr-timeline-point {
  opacity: 1;
  transform: translateY(0);
}

.sr-timeline-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--color-bg-elevated);
  flex-shrink: 0;
  margin-bottom: 8px;
}

.sr-timeline-dot--info {
  background: var(--color-info);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--color-info) 20%, transparent);
}

.sr-timeline-dot--accent {
  background: var(--color-accent);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--color-accent) 20%, transparent);
}

.sr-timeline-dot--brand {
  background: var(--color-brand);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--color-brand) 20%, transparent);
}

.sr-timeline-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 2px;
}

.sr-timeline-year {
  font-size: 0.75rem;
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--color-text-primary);
}

.sr-timeline-milestone {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.sr-timeline-detail {
  font-size: 0.625rem;
  color: var(--color-text-tertiary);
  line-height: 1.4;
  max-width: 180px;
}

/* Mobile timeline: stack vertically */
@media (max-width: 680px) {
  .sr-timeline-track {
    flex-direction: column;
    gap: 16px;
    padding-left: 12px;
  }

  .sr-timeline-line {
    top: 9px;
    bottom: 9px;
    left: 17px;
    right: auto;
    width: 2px;
    height: auto;
    background: linear-gradient(to bottom, var(--color-info), var(--color-accent), var(--color-brand));
    transform: scaleY(0);
    transform-origin: top;
  }

  .is-visible .sr-timeline-line {
    transform: scaleY(1);
  }

  .sr-timeline-point {
    flex-direction: row;
    align-items: flex-start;
    gap: 12px;
  }

  .sr-timeline-dot {
    margin-bottom: 0;
    margin-top: 2px;
  }

  .sr-timeline-content {
    align-items: flex-start;
    text-align: left;
  }

  .sr-timeline-detail {
    max-width: none;
  }
}
</style>
