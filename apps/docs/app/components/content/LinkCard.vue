<script setup lang="ts">
defineProps<{
  to: string
  title: string
  description?: string
}>()
</script>

<template>
  <NuxtLink :to="to" class="link-card">
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
  background: var(--surface-2);
  box-shadow: var(--shadow-1);
  border-radius: 10px;
  text-decoration: none;
  color: inherit;
  overflow: hidden;
  transition:
    background var(--motion-moderate) var(--ease-spring),
    box-shadow var(--motion-moderate) var(--ease-spring);
}

/* Hover: +6% surface, one elevation step — no lift, no spotlight */
.link-card:hover {
  background: color-mix(in srgb, var(--surface-2) 94%, var(--surface-tint));
  box-shadow: var(--shadow-2);
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
  transition: color var(--motion-moderate), transform var(--motion-moderate) var(--ease-spring);
}

.link-card:hover .link-card-arrow {
  color: var(--color-brand);
  transform: translateX(3px);
}
</style>
