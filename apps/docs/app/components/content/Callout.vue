<script setup lang="ts">
withDefaults(
  defineProps<{
    type?: 'tip' | 'warning' | 'danger' | 'info'
    title?: string
  }>(),
  { type: 'tip' },
)
</script>

<template>
  <div class="callout" :class="`callout-${type}`">
    <div v-if="title" class="callout-title">{{ title }}</div>
    <div class="callout-content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.callout {
  margin: 1.5rem 0;
  padding: 14px 20px;
  border-left: 1px solid var(--color-border-default);
  border-radius: 0 6px 6px 0;
}

.callout-title {
  font-weight: 550;
  font-size: 0.8125rem;
  margin-bottom: 6px;
}

.callout-content :deep(> *:first-child) {
  margin-top: 0;
}

.callout-content :deep(> *:last-child) {
  margin-bottom: 0;
}

/* Tip */
.callout-tip {
  border-left-color: var(--color-brand);
  background: var(--color-brand-soft);
}

.callout-tip .callout-title {
  color: var(--color-brand);
}

/* Warning */
.callout-warning {
  border-left-color: var(--color-warning);
  background: var(--color-warning-subtle);
}

.callout-warning .callout-title {
  color: var(--color-warning);
}

/* Danger */
.callout-danger {
  border-left-color: var(--color-error);
  background: var(--color-error-subtle);
}

.callout-danger .callout-title {
  color: var(--color-error);
}

/* Info */
.callout-info {
  border-left-color: var(--color-info);
  background: var(--color-info-subtle);
}

.callout-info .callout-title {
  color: var(--color-info);
}
</style>
