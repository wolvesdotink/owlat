<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const services = [
  {
    id: 'convex',
    label: 'Convex Backend',
    detail: 'DB + Vectors + Files + Real-time',
    icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4',
    color: 'brand',
    required: true,
  },
  {
    id: 'web',
    label: 'Web App',
    detail: 'Nuxt dashboard & email builder',
    icon: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
    color: 'brand',
    required: true,
  },
  {
    id: 'mta',
    label: 'MTA',
    detail: 'SMTP delivery & bounce processing',
    icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
    color: 'accent',
    required: true,
  },
  {
    id: 'redis',
    label: 'Redis',
    detail: 'MTA job queue & rate limiting',
    icon: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z',
    color: 'accent',
    required: true,
  },
  {
    id: 'clamav',
    label: 'ClamAV',
    detail: 'Attachment antivirus scanning',
    icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
    color: 'accent',
    required: true,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    detail: 'Optional self-hosted LLM',
    icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
    color: 'info',
    required: false,
  },
]

const connections = [
  { from: 'web', to: 'convex' },
  { from: 'mta', to: 'convex' },
  { from: 'mta', to: 'redis' },
  { from: 'mta', to: 'clamav' },
]
</script>

<template>
  <div class="sh" :class="{ 'is-visible': visible }">
    <!-- Service grid -->
    <div class="sh-grid">
      <div
        v-for="(svc, i) in services"
        :key="svc.id"
        class="sh-service"
        :class="[`sh-service--${svc.color}`, { 'sh-service--optional': !svc.required }]"
        :style="{ '--i': i }"
      >
        <div class="sh-service-icon" :class="`sh-service-icon--${svc.color}`">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="svc.icon" /></svg>
        </div>
        <div class="sh-service-info">
          <span class="sh-service-label">{{ svc.label }}</span>
          <span class="sh-service-detail">{{ svc.detail }}</span>
        </div>
        <span v-if="!svc.required" class="sh-badge">optional</span>
      </div>
    </div>

    <!-- Legend -->
    <div class="sh-legend">
      <div class="sh-legend-item">
        <span class="sh-legend-dot sh-legend-dot--required"></span>
        <span>Required</span>
      </div>
      <div class="sh-legend-item">
        <span class="sh-legend-dot sh-legend-dot--optional"></span>
        <span>Optional</span>
      </div>
      <div class="sh-legend-note">
        All services run via <code>docker compose up</code>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sh {
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sh-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

@media (max-width: 600px) {
  .sh-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 400px) {
  .sh-grid {
    grid-template-columns: 1fr;
  }
}

.sh-service {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px;
  border-radius: 10px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-default);
  position: relative;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 0.45s var(--ease-spring), transform 0.45s var(--ease-spring), border-color var(--motion-moderate), box-shadow var(--motion-moderate);
  transition-delay: calc(0.1s + var(--i) * 0.06s);
}

.is-visible .sh-service {
  opacity: 1;
  transform: translateY(0);
}

.sh-service:hover {
  border-color: var(--color-border-strong);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  transition-delay: 0s;
}

.sh-service--optional {
  border-style: dashed;
}

.sh-service-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  flex-shrink: 0;
}

.sh-service-icon--brand { background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface)); color: var(--color-brand); }
.sh-service-icon--accent { background: color-mix(in oklab, var(--color-accent) 10%, var(--color-bg-surface)); color: var(--color-accent); }
.sh-service-icon--info { background: color-mix(in oklab, var(--color-info) 10%, var(--color-bg-surface)); color: var(--color-info); }

.sh-service-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.sh-service-label {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  line-height: 1.3;
}

.sh-service-detail {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
}

.sh-badge {
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 0.5625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: 3px;
  background: color-mix(in oklab, var(--color-info) 10%, var(--color-bg-surface));
  color: var(--color-info);
  border: 1px solid color-mix(in oklab, var(--color-info) 20%, var(--color-border-subtle));
}

/* Legend */
.sh-legend {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--color-bg-soft);
  border: 1px solid var(--color-border-subtle);
  opacity: 0;
  transition: opacity var(--motion-slow) var(--ease-spring);
  transition-delay: 0.5s;
}

.is-visible .sh-legend {
  opacity: 1;
}

.sh-legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.6875rem;
  color: var(--color-text-secondary);
}

.sh-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.sh-legend-dot--required {
  background: var(--color-brand);
}

.sh-legend-dot--optional {
  border: 1.5px dashed var(--color-info);
}

.sh-legend-note {
  margin-left: auto;
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
}

.sh-legend-note code {
  font-size: 0.625rem;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  font-family: var(--font-mono);
}
</style>
