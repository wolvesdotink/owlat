<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const authItems = [
  { name: 'Users', detail: 'Auth', icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z' },
  { name: 'Sessions', detail: 'JWT', icon: 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z' },
  { name: 'Organizations', detail: 'Teams', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z' },
]

const adapterFeatures = [
  'Stores user/session data in Convex',
  'Provides auth routes via HTTP handlers',
  'Links sessions to organizations',
]
</script>

<template>
  <div class="arch-auth" :class="{ 'is-visible': visible }">
    <!-- BetterAuth layer -->
    <div class="auth-layer auth-layer--top">
      <div class="auth-layer-header">
        <div class="auth-layer-badge">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
        </div>
        <span class="auth-layer-label">BetterAuth</span>
      </div>
      <div class="auth-items">
        <div
          v-for="(item, i) in authItems"
          :key="item.name"
          class="auth-item"
          :style="{ '--i': i }"
        >
          <div class="auth-item-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="item.icon" /></svg>
          </div>
          <div class="auth-item-text">
            <span class="auth-item-name">{{ item.name }}</span>
            <span class="auth-item-detail">{{ item.detail }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Connector -->
    <div class="auth-connector">
      <div class="auth-connector-line" />
      <svg class="auth-connector-chevron" width="12" height="8" viewBox="0 0 12 8" fill="none">
        <path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>

    <!-- Convex Adapter layer -->
    <div class="auth-layer auth-layer--bottom">
      <div class="auth-layer-header">
        <div class="auth-layer-badge auth-layer-badge--accent">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" /></svg>
        </div>
        <span class="auth-layer-label">Convex Adapter</span>
      </div>
      <ul class="auth-features">
        <li
          v-for="(feat, i) in adapterFeatures"
          :key="feat"
          class="auth-feature"
          :style="{ '--i': i + 3 }"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14" /><path d="M12 5l7 7-7 7" /></svg>
          <span>{{ feat }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.arch-auth {
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

/* Layers */
.auth-layer {
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
  padding: 16px 18px;
  background: var(--color-bg-elevated);
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateY(14px);
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring), border-color var(--motion-moderate), box-shadow var(--motion-moderate);
}

.auth-layer--top {
  transition-delay: 0s;
}

.auth-layer--top::after {
  content: '';
  position: absolute;
  top: -40px;
  right: -40px;
  width: 120px;
  height: 120px;
  background: radial-gradient(circle, rgba(196, 120, 90, 0.06) 0%, transparent 70%);
  pointer-events: none;
}


.auth-layer--bottom {
  transition-delay: 0.2s;
}

.auth-layer:hover {
  border-color: var(--color-border-strong);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  transition-delay: 0s;
  animation: none;
}

.is-visible .auth-layer {
  opacity: 1;
  transform: translateY(0);
}

.auth-layer-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.auth-layer-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
  color: var(--color-brand);
}

.auth-layer-badge--accent {
  background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface));
  color: var(--color-accent);
}

.auth-layer-label {
  font-weight: 600;
  font-size: 0.9375rem;
  color: var(--color-text-primary);
}

/* Auth items */
.auth-items {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

@media (max-width: 580px) {
  .auth-items {
    grid-template-columns: 1fr;
  }
}

.auth-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  border: 1px solid transparent;
  transition: border-color var(--motion-moderate), transform var(--motion-moderate) var(--ease-spring), background var(--motion-moderate);
  opacity: 0;
  transform: translateY(8px);
}

.is-visible .auth-item {
  opacity: 1;
  transform: translateY(0);
  transition-delay: calc(0.15s + var(--i) * 0.08s);
}

.auth-item:hover {
  border-color: var(--color-border-default);
  background: var(--color-bg-surface-hover);
  transform: translateY(-1px);
  transition-delay: 0s;
}

.auth-item-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--color-bg-elevated);
  color: var(--color-brand);
  flex-shrink: 0;
  transition: box-shadow var(--motion-moderate);
}

.auth-item:hover .auth-item-icon {
  box-shadow: 0 0 10px rgba(196, 120, 90, 0.15);
}

.auth-item-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.auth-item-name {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
}

.auth-item-detail {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

/* Connector */
.auth-connector {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 0;
  opacity: 0;
  transition: opacity var(--motion-slow) var(--ease-spring) var(--motion-fast);
}

.is-visible .auth-connector {
  opacity: 1;
}

.auth-connector-line {
  width: 2px;
  height: 20px;
  background: var(--color-border-strong);
  border-radius: 1px;
  transform-origin: top;
  transform: scaleY(0);
  transition: transform var(--motion-slow) var(--ease-spring) var(--motion-moderate);
}

.is-visible .auth-connector-line {
  transform: scaleY(1);
}

.auth-connector-chevron {
  color: var(--color-brand-dim);
}


/* Features list */
.auth-features {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.auth-feature {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  padding: 6px 10px;
  border-radius: 6px;
  transition: color var(--motion-moderate), background var(--motion-moderate);
  opacity: 0;
  transform: translateX(-6px);
}

.is-visible .auth-feature {
  opacity: 1;
  transform: translateX(0);
  transition: color var(--motion-moderate), background var(--motion-moderate), opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(0.2s + var(--i) * 0.08s);
}

.auth-feature:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-surface);
  transition-delay: 0s;
}

.auth-feature svg {
  color: var(--color-accent-muted);
  flex-shrink: 0;
  transition: transform var(--motion-moderate) var(--ease-spring);
}

.auth-feature:hover svg {
  transform: translateX(2px);
  color: var(--color-accent);
}

/* ── Ambient animations ── */
.is-visible .auth-layer {
}

.is-visible .auth-layer--bottom {
  animation-delay: 2s;
}

</style>
