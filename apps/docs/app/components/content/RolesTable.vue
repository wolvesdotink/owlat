<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const roles = [
  {
    name: 'owner',
    color: 'brand',
    capabilities: ['Full access', 'Delete team', 'Transfer ownership'],
    icon: 'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z',
  },
  {
    name: 'admin',
    color: 'accent',
    capabilities: ['Full access', 'Manage members', 'Cannot manage owners'],
    icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
  },
  {
    name: 'editor',
    color: 'info',
    capabilities: ['Create & edit content', 'No team management'],
    icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  },
]
</script>

<template>
  <div class="roles-table" :class="{ 'is-visible': visible }">
    <div class="rt-grid">
      <div
        v-for="(role, i) in roles"
        :key="role.name"
        class="rt-role"
        :class="`rt-role--${role.color}`"
        :style="{ '--i': i }"
      >
        <div class="rt-role-header">
          <div class="rt-role-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="role.icon" /></svg>
          </div>
          <code class="rt-role-name">{{ role.name }}</code>
        </div>
        <ul class="rt-caps">
          <li v-for="cap in role.capabilities" :key="cap" class="rt-cap">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14" /><path d="M12 5l7 7-7 7" /></svg>
            <span>{{ cap }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.roles-table {
  margin: 2rem 0;
}

.rt-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

@media (max-width: 580px) {
  .rt-grid {
    grid-template-columns: 1fr;
  }
}

.rt-role {
  border: 1px solid var(--color-border-default);
  border-radius: 10px;
  padding: 14px 16px;
  background: var(--color-bg-elevated);
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 0.5s var(--ease-out-expo), transform 0.5s var(--ease-out-expo), border-color 0.25s, box-shadow 0.3s;
}

.is-visible .rt-role {
  opacity: 1;
  transform: translateY(0);
  transition-delay: calc(0.1s + var(--i) * 0.1s);
}

.rt-role:hover {
  border-color: var(--color-border-strong);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  transition-delay: 0s;
}

.rt-role-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.rt-role-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  flex-shrink: 0;
}

.rt-role--brand .rt-role-icon {
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
  color: var(--color-brand);
}

.rt-role--accent .rt-role-icon {
  background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface));
  color: var(--color-accent);
}

.rt-role--info .rt-role-icon {
  background: color-mix(in oklab, var(--color-info) 12%, var(--color-bg-surface));
  color: var(--color-info);
}

.rt-role-name {
  font-size: 0.875rem;
  font-weight: 600;
  font-family: var(--font-mono);
  color: var(--color-text-primary);
}

.rt-caps {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rt-cap {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  transition: color 0.25s;
}

.rt-cap svg {
  flex-shrink: 0;
  transition: transform 0.25s var(--ease-out-expo), color 0.25s;
}

.rt-role--brand .rt-cap svg { color: var(--color-brand-muted); }
.rt-role--accent .rt-cap svg { color: var(--color-accent-muted); }
.rt-role--info .rt-cap svg { color: var(--color-info); opacity: 0.6; }

.rt-role:hover .rt-cap {
  color: var(--color-text-primary);
}

.rt-role:hover .rt-cap svg {
  transform: translateX(2px);
}
</style>
