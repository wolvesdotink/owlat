<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    type?: 'tip' | 'warning' | 'danger' | 'info'
    title?: string
  }>(),
  { type: 'tip' },
)

const iconPaths: Record<string, string> = {
  tip: 'M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z',
  warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  danger: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
  info: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
}
</script>

<template>
  <div class="callout" :class="`callout-${type}`">
    <div v-if="title" class="callout-title">
      <svg
        class="callout-icon"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path :d="iconPaths[type]" />
      </svg>
      <span>{{ title }}</span>
    </div>
    <div class="callout-content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.callout {
  margin: 1.5rem 0;
  padding: 16px 20px;
  border: 1px solid var(--color-border-default);
  border-radius: 10px;
  animation: callout-enter 0.5s var(--ease-spring) both;
}

@keyframes callout-enter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.callout-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 0.8125rem;
  margin-bottom: 8px;
}

.callout-icon {
}


.callout-content :deep(> *:first-child) {
  margin-top: 0;
}

.callout-content :deep(> *:last-child) {
  margin-bottom: 0;
}

/* Tip */
.callout-tip {
  border-color: color-mix(in oklab, var(--color-brand) 35%, var(--color-border-default));
  background: color-mix(in oklab, var(--color-brand) 4%, var(--color-bg-soft));
}

.callout-tip .callout-title {
  color: var(--color-brand);
}

/* Warning */
.callout-warning {
  border-color: color-mix(in oklab, var(--color-warning) 35%, var(--color-border-default));
  background: color-mix(in oklab, var(--color-warning) 4%, var(--color-bg-soft));
}

.callout-warning .callout-title {
  color: var(--color-warning);
}

/* Danger */
.callout-danger {
  border-color: color-mix(in oklab, var(--color-error) 35%, var(--color-border-default));
  background: color-mix(in oklab, var(--color-error) 4%, var(--color-bg-soft));
}

.callout-danger .callout-title {
  color: var(--color-error);
}

/* Info */
.callout-info {
  border-color: color-mix(in oklab, var(--color-info) 35%, var(--color-border-default));
  background: color-mix(in oklab, var(--color-info) 4%, var(--color-bg-soft));
}

.callout-info .callout-title {
  color: var(--color-info);
}
</style>
