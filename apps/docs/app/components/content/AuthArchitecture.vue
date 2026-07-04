<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const frontendComposables = [
  {
    name: 'useAuth()',
    items: ['session', 'user', 'orgId'],
    icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  },
  {
    name: 'useOrganization()',
    items: ['members', 'invitations', 'role management'],
    icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z',
  },
]

const betterAuthTables = [
  { name: 'User', detail: 'auto-created', icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0z' },
  { name: 'Session', detail: 'auto-created', icon: 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z' },
  { name: 'Organization', detail: 'auto-created', icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4' },
  { name: 'Member', detail: 'auto-created', icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z' },
  { name: 'Invitation', detail: 'auto-created', icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
]
</script>

<template>
  <div class="auth-arch" :class="{ 'is-visible': visible }">
    <!-- Frontend Layer -->
    <div class="aa-layer aa-layer--frontend" :style="{ '--s': 0 }">
      <div class="aa-layer-header">
        <div class="aa-badge">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1" /></svg>
        </div>
        <span class="aa-label">Frontend</span>
      </div>
      <div class="aa-composables">
        <div
          v-for="(comp, ci) in frontendComposables"
          :key="comp.name"
          class="aa-composable"
          :style="{ '--i': ci }"
        >
          <div class="aa-composable-header">
            <div class="aa-composable-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="comp.icon" /></svg>
            </div>
            <code class="aa-composable-name">{{ comp.name }}</code>
          </div>
          <div class="aa-composable-items">
            <span v-for="item in comp.items" :key="item" class="aa-composable-item">{{ item }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Connector -->
    <div class="aa-connector">
      <div class="aa-connector-line" />
      <svg class="aa-connector-chevron" width="12" height="8" viewBox="0 0 12 8" fill="none">
        <path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>

    <!-- BetterAuth Layer -->
    <div class="aa-layer aa-layer--betterauth" :style="{ '--s': 2 }">
      <div class="aa-layer-header">
        <div class="aa-badge aa-badge--accent">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
        </div>
        <span class="aa-label">BetterAuth</span>
        <span class="aa-sublabel">Convex</span>
      </div>
      <div class="aa-tables">
        <div
          v-for="(table, ti) in betterAuthTables"
          :key="table.name"
          class="aa-table"
          :style="{ '--i': ti + 2 }"
        >
          <div class="aa-table-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="table.icon" /></svg>
          </div>
          <div class="aa-table-text">
            <span class="aa-table-name">{{ table.name }}</span>
            <span class="aa-table-detail">{{ table.detail }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auth-arch {
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

/* Layers */
.aa-layer {
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

.is-visible .aa-layer {
  opacity: 1;
  transform: translateY(0);
}

.aa-layer:hover {
  border-color: var(--color-border-strong);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  transition-delay: 0s;
}

.aa-layer--frontend::after {
  content: '';
  position: absolute;
  top: -40px;
  right: -40px;
  width: 120px;
  height: 120px;
  background: radial-gradient(circle, rgba(196, 120, 90, 0.06) 0%, transparent 70%);
  pointer-events: none;
}


.aa-layer-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.aa-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
  color: var(--color-brand);
}

.aa-badge--accent {
  background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface));
  color: var(--color-accent);
}

.aa-label {
  font-weight: 600;
  font-size: 0.9375rem;
  color: var(--color-text-primary);
}

.aa-sublabel {
  font-size: 0.75rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

/* Composables */
.aa-composables {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

@media (max-width: 580px) {
  .aa-composables {
    grid-template-columns: 1fr;
  }
}

.aa-composable {
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  border: 1px solid transparent;
  transition: border-color var(--motion-moderate), background var(--motion-moderate), transform var(--motion-moderate) var(--ease-spring);
  opacity: 0;
  transform: translateY(8px);
}

.is-visible .aa-composable {
  opacity: 1;
  transform: translateY(0);
  transition-delay: calc(0.15s + var(--i) * 0.1s);
}

.aa-composable:hover {
  border-color: var(--color-border-default);
  background: var(--color-bg-surface-hover);
  transform: translateY(-1px);
  transition-delay: 0s;
}

.aa-composable-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.aa-composable-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: var(--color-bg-elevated);
  color: var(--color-brand);
  flex-shrink: 0;
  transition: box-shadow var(--motion-moderate);
}

.aa-composable:hover .aa-composable-icon {
  box-shadow: 0 0 10px rgba(196, 120, 90, 0.15);
}

.aa-composable-name {
  font-size: 0.8125rem;
  font-weight: 600;
  font-family: var(--font-mono);
  color: var(--color-brand);
}

.aa-composable-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.aa-composable-item {
  padding: 3px 10px;
  border-radius: 9999px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  font-size: 0.6875rem;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  transition: border-color var(--motion-moderate), color var(--motion-moderate);
}

.aa-composable:hover .aa-composable-item {
  border-color: var(--color-border-default);
  color: var(--color-text-primary);
}

/* Connector */
.aa-connector {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 0;
  opacity: 0;
  transition: opacity var(--motion-slow) var(--ease-spring) var(--motion-fast);
}

.is-visible .aa-connector {
  opacity: 1;
}

.aa-connector-line {
  width: 2px;
  height: 20px;
  background: var(--color-border-strong);
  border-radius: 1px;
  transform-origin: top;
  transform: scaleY(0);
  transition: transform var(--motion-slow) var(--ease-spring) var(--motion-moderate);
}

.is-visible .aa-connector-line {
  transform: scaleY(1);
}

.aa-connector-chevron {
  color: var(--color-brand-dim);
}


/* BetterAuth tables */
.aa-tables {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
}

@media (max-width: 720px) {
  .aa-tables {
    grid-template-columns: repeat(3, 1fr);
  }
}

@media (max-width: 480px) {
  .aa-tables {
    grid-template-columns: repeat(2, 1fr);
  }
}

.aa-table {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 8px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  border: 1px solid transparent;
  text-align: center;
  transition: border-color var(--motion-moderate), background var(--motion-moderate), transform var(--motion-moderate) var(--ease-spring);
  opacity: 0;
  transform: translateY(8px);
}

.is-visible .aa-table {
  opacity: 1;
  transform: translateY(0);
  transition-delay: calc(0.2s + var(--i) * 0.07s);
}

.aa-table:hover {
  border-color: var(--color-border-default);
  background: var(--color-bg-surface-hover);
  transform: translateY(-1px);
  transition-delay: 0s;
}

.aa-table-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: var(--color-bg-elevated);
  color: var(--color-accent);
  flex-shrink: 0;
}

.aa-table-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.aa-table-name {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
}

.aa-table-detail {
  font-size: 0.625rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}


.is-visible .aa-layer--betterauth {
  animation-delay: 2s;
}

</style>
