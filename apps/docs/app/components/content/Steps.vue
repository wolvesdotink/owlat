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

/* Vertical connecting line — grows in */
.steps::before {
  content: '';
  position: absolute;
  left: 11px;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: var(--color-border-default);
  border-radius: 1px;
  transform-origin: top;
  animation: line-grow 0.8s var(--ease-out-expo) 0.1s both;
}

@keyframes line-grow {
  from { transform: scaleY(0); }
  to { transform: scaleY(1); }
}

/* Numbered circle on each h3 */
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
  background: var(--color-brand);
  color: #fff;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1;
  z-index: 1;
  animation: step-pop 0.4s var(--ease-out-expo) both;
}

.steps :deep(h3:nth-of-type(1))::before { animation-delay: 0.2s; }
.steps :deep(h3:nth-of-type(2))::before { animation-delay: 0.35s; }
.steps :deep(h3:nth-of-type(3))::before { animation-delay: 0.5s; }
.steps :deep(h3:nth-of-type(4))::before { animation-delay: 0.65s; }
.steps :deep(h3:nth-of-type(5))::before { animation-delay: 0.8s; }
.steps :deep(h3:nth-of-type(6))::before { animation-delay: 0.95s; }

@keyframes step-pop {
  0% { transform: scale(0); opacity: 0; }
  60% { transform: scale(1.15); }
  100% { transform: scale(1); opacity: 1; }
}
</style>
