<script setup lang="ts">
withDefaults(
  defineProps<{
    type?: 'info' | 'warning' | 'success' | 'danger'
  }>(),
  { type: 'info' },
)
</script>

<template>
  <span class="badge" :class="`badge-${type}`">
    <slot />
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  line-height: 1.5;
  border-radius: 9999px;
  vertical-align: middle;
}

.badge-info {
  background: var(--color-info-subtle);
  color: var(--color-info);
}

.badge-warning {
  background: var(--color-warning-subtle);
  color: var(--color-warning);
}

.badge-success {
  background: var(--color-success-subtle);
  color: var(--color-success);
}

.badge-danger {
  background: var(--color-error-subtle);
  color: var(--color-error);
}
</style>
