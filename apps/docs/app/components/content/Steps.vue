<template>
  <div class="steps">
    <slot />
  </div>
</template>

<style scoped>
.steps {
  position: relative;
  padding-left: 40px;
  margin: 1.5rem 0;
  counter-reset: step;
}

/* Vertical connecting line */
.steps::before {
  content: '';
  position: absolute;
  left: 11px;
  top: 4px;
  bottom: 4px;
  width: 1px;
  background: var(--color-border-subtle);
}

/* Slim numbered marker on each h3 */
.steps :deep(h3) {
  position: relative;
  counter-increment: step;
  margin-top: 2rem;
  padding-top: 0;
}

.steps :deep(h3:first-child),
.steps :deep(h3:first-of-type) {
  margin-top: 0;
}

.steps :deep(h3)::before {
  content: counter(step);
  position: absolute;
  left: -40px;
  top: 1px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 9999px;
  background: var(--color-bg-base);
  border: 1px solid var(--color-border-default);
  color: var(--color-text-tertiary);
  font-size: 0.75rem;
  font-weight: 550;
  line-height: 1;
  z-index: 1;
}
</style>
