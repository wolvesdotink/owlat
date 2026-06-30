<script setup lang="ts">
defineProps<{
  to: string
  title: string
  description?: string
}>()

function onMouseMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  el.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`)
  el.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`)
}
</script>

<template>
  <NuxtLink :to="to" class="link-card" @mousemove="onMouseMove">
    <div class="link-card-spotlight" />
    <div class="link-card-body">
      <div class="link-card-title">{{ title }}</div>
      <div v-if="description" class="link-card-description">
        {{ description }}
      </div>
    </div>
    <svg
      class="link-card-arrow"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  </NuxtLink>
</template>

<style scoped>
.link-card {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 1rem 0;
  padding: 16px 20px;
  border: 1px solid var(--color-border-default);
  border-radius: 10px;
  text-decoration: none;
  color: inherit;
  overflow: hidden;
  transition: border-color 0.3s, transform 0.3s var(--ease-out-expo), box-shadow 0.3s var(--ease-out-expo);
}

.link-card:hover {
  border-color: color-mix(in oklab, var(--color-brand) 50%, var(--color-border-default));
  transform: translateY(-2px) scale(1.005);
  box-shadow: 0 8px 24px color-mix(in oklab, var(--color-brand) 10%, transparent);
}

.link-card-spotlight {
  position: absolute;
  inset: 0;
  opacity: 0;
  background: radial-gradient(
    300px circle at var(--mouse-x, 50%) var(--mouse-y, 50%),
    rgba(196, 120, 90, 0.08) 0%,
    transparent 70%
  );
  transition: opacity 0.3s ease;
  pointer-events: none;
}

.link-card:hover .link-card-spotlight {
  opacity: 1;
}

.link-card-body {
  min-width: 0;
  position: relative;
}

.link-card-title {
  font-weight: 600;
  font-size: 0.9375rem;
  color: var(--color-text-primary);
}

.link-card-description {
  margin-top: 4px;
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.link-card-arrow {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
  transition: color 0.25s, transform 0.3s var(--ease-out-expo);
}

.link-card:hover .link-card-arrow {
  color: var(--color-brand);
  transform: translateX(3px);
}
</style>
