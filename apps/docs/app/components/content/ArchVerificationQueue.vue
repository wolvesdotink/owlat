<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const queueItems = [
  {
    id: 1,
    type: 'email',
    typeLabel: 'Email Reply',
    icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
    subject: 'Re: Booking reschedule request',
    from: 'Sarah Chen',
    confidence: 94,
    confidenceLevel: 'high',
    time: '12s ago',
    status: 'auto-approved',
  },
  {
    id: 2,
    type: 'email',
    typeLabel: 'Email Reply',
    icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
    subject: 'Re: Billing dispute — double charge',
    from: 'Marcus Rivera',
    confidence: 67,
    confidenceLevel: 'medium',
    time: '2m ago',
    status: 'review',
  },
  {
    id: 3,
    type: 'ticket',
    typeLabel: 'Ticket',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
    subject: 'Feature request: bulk export contacts',
    from: 'Internal — Product',
    confidence: 82,
    confidenceLevel: 'high',
    time: '5m ago',
    status: 'review',
  },
  {
    id: 4,
    type: 'code',
    typeLabel: 'Code Change',
    icon: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
    subject: 'PR #847: Add CSV export endpoint',
    from: 'Coding Agent',
    confidence: 41,
    confidenceLevel: 'low',
    time: '8m ago',
    status: 'review',
  },
]

const stats = [
  { label: 'Pending', value: '3', color: 'brand' },
  { label: 'Auto-approved today', value: '24', color: 'success' },
  { label: 'Avg response', value: '8s', color: 'info' },
]
</script>

<template>
  <div class="vq" :class="{ 'is-visible': visible }">

    <!-- Stats bar -->
    <div class="vq-stats" :style="{ '--stagger': 0 }">
      <div
        v-for="(stat, i) in stats"
        :key="stat.label"
        class="vq-stat"
        :class="`vq-stat--${stat.color}`"
        :style="{ '--i': i }"
      >
        <span class="vq-stat-value">{{ stat.value }}</span>
        <span class="vq-stat-label">{{ stat.label }}</span>
      </div>
    </div>

    <!-- Queue list -->
    <div class="vq-list" :style="{ '--stagger': 1 }">
      <div
        v-for="(item, i) in queueItems"
        :key="item.id"
        class="vq-item"
        :class="[
          `vq-item--${item.confidenceLevel}`,
          { 'is-auto': item.status === 'auto-approved' }
        ]"
        :style="{ '--i': i }"
      >
        <!-- Left: confidence bar -->
        <div class="vq-item-confidence">
          <div class="vq-confidence-bar">
            <div
              class="vq-confidence-fill"
              :class="`vq-confidence-fill--${item.confidenceLevel}`"
              :style="{ height: `${item.confidence}%` }"
            />
          </div>
          <span class="vq-confidence-num" :class="`vq-confidence-num--${item.confidenceLevel}`">{{ item.confidence }}%</span>
        </div>

        <!-- Center: content -->
        <div class="vq-item-content">
          <div class="vq-item-top">
            <div class="vq-item-type">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="item.icon" /></svg>
              <span>{{ item.typeLabel }}</span>
            </div>
            <span class="vq-item-time">{{ item.time }}</span>
          </div>
          <span class="vq-item-subject">{{ item.subject }}</span>
          <span class="vq-item-from">from {{ item.from }}</span>
        </div>

        <!-- Right: actions -->
        <div class="vq-item-actions">
          <template v-if="item.status === 'auto-approved'">
            <div class="vq-auto-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
              <span>Auto-approved</span>
            </div>
          </template>
          <template v-else>
            <button class="vq-action vq-action--approve" title="Approve">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
            </button>
            <button class="vq-action vq-action--edit" title="Edit">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            </button>
            <button class="vq-action vq-action--reject" title="Reject">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </template>
        </div>
      </div>
    </div>

    <!-- Confidence legend -->
    <div class="vq-legend" :style="{ '--stagger': 2 }">
      <div class="vq-legend-item">
        <span class="vq-legend-dot vq-legend-dot--high" />
        <span class="vq-legend-label">High confidence</span>
        <span class="vq-legend-desc">— can auto-approve per org policy</span>
      </div>
      <div class="vq-legend-item">
        <span class="vq-legend-dot vq-legend-dot--medium" />
        <span class="vq-legend-label">Medium</span>
        <span class="vq-legend-desc">— human review recommended</span>
      </div>
      <div class="vq-legend-item">
        <span class="vq-legend-dot vq-legend-dot--low" />
        <span class="vq-legend-label">Low</span>
        <span class="vq-legend-desc">— requires human decision</span>
      </div>
    </div>

    <!-- Audit trail note -->
    <div class="vq-audit" :style="{ '--stagger': 3 }">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
      <span>Full audit trail — every action logged with provenance: what knowledge was retrieved, what reasoning applied, who approved</span>
    </div>

  </div>
</template>

<style scoped>
.vq {
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ── Stats bar ── */
.vq-stats {
  display: flex;
  gap: 8px;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 0.5s var(--ease-out-expo), transform 0.5s var(--ease-out-expo);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .vq-stats {
  opacity: 1;
  transform: translateY(0);
}

@media (max-width: 480px) {
  .vq-stats {
    flex-direction: column;
  }
}

.vq-stat {
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-default);
  opacity: 0;
  transform: translateY(6px);
  transition: opacity 0.4s var(--ease-out-expo), transform 0.4s var(--ease-out-expo), border-color 0.25s;
  transition-delay: calc(0.1s + var(--i) * 0.06s);
}

.is-visible .vq-stat {
  opacity: 1;
  transform: translateY(0);
}

.vq-stat:hover {
  border-color: var(--color-border-strong);
  transition-delay: 0s;
}

.vq-stat-value {
  font-weight: 700;
  font-size: 1.125rem;
  letter-spacing: -0.02em;
}

.vq-stat--brand .vq-stat-value { color: var(--color-brand); }
.vq-stat--success .vq-stat-value { color: var(--color-success); }
.vq-stat--info .vq-stat-value { color: var(--color-info); }

.vq-stat-label {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

/* ── Queue list ── */
.vq-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 0.5s var(--ease-out-expo), transform 0.5s var(--ease-out-expo);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .vq-list {
  opacity: 1;
  transform: translateY(0);
}

/* ── Queue item ── */
.vq-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-default);
  opacity: 0;
  transform: translateX(-8px);
  transition: opacity 0.45s var(--ease-out-expo), transform 0.45s var(--ease-out-expo), border-color 0.25s, box-shadow 0.25s;
  transition-delay: calc(0.15s + var(--i) * 0.08s);
}

.is-visible .vq-item {
  opacity: 1;
  transform: translateX(0);
}

.vq-item:hover {
  border-color: var(--color-border-strong);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
  transition-delay: 0s;
}

.vq-item.is-auto {
  opacity: 0;
  border-color: color-mix(in oklab, var(--color-success) 15%, var(--color-border-default));
  background: color-mix(in oklab, var(--color-success) 2%, var(--color-bg-elevated));
}

.is-visible .vq-item.is-auto {
  opacity: 0.7;
}

.vq-item.is-auto:hover {
  opacity: 1;
}

/* ── Confidence indicator ── */
.vq-item-confidence {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  width: 32px;
}

.vq-confidence-bar {
  width: 4px;
  height: 32px;
  border-radius: 2px;
  background: var(--color-bg-surface);
  position: relative;
  overflow: hidden;
}

.vq-confidence-fill {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  border-radius: 2px;
  transition: height 0.6s var(--ease-out-expo);
}

.vq-confidence-fill--high { background: var(--color-success); }
.vq-confidence-fill--medium { background: var(--color-warning); }
.vq-confidence-fill--low { background: var(--color-error); }

.vq-confidence-num {
  font-size: 0.625rem;
  font-weight: 700;
  font-family: var(--font-mono);
}

.vq-confidence-num--high { color: var(--color-success); }
.vq-confidence-num--medium { color: var(--color-warning); }
.vq-confidence-num--low { color: var(--color-error); }

/* ── Item content ── */
.vq-item-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.vq-item-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.vq-item-type {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-tertiary);
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--color-bg-surface);
}

.vq-item-type svg {
  flex-shrink: 0;
}

.vq-item-time {
  font-size: 0.625rem;
  color: var(--color-text-disabled);
  font-family: var(--font-mono);
  margin-left: auto;
}

.vq-item-subject {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vq-item.is-auto .vq-item-subject {
  text-decoration: line-through;
  text-decoration-color: color-mix(in oklab, var(--color-success) 40%, transparent);
}

.vq-item-from {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
}

/* ── Item actions ── */
.vq-item-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.vq-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 7px;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface);
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s, background 0.2s, box-shadow 0.2s;
  font-family: inherit;
}

.vq-action:hover {
  background: var(--color-bg-surface-hover);
  border-color: var(--color-border-default);
}

.vq-action--approve {
  color: var(--color-success);
  border-color: color-mix(in oklab, var(--color-success) 20%, var(--color-border-subtle));
}

.vq-action--approve:hover {
  background: color-mix(in oklab, var(--color-success) 8%, var(--color-bg-surface));
  border-color: color-mix(in oklab, var(--color-success) 35%, var(--color-border-default));
  box-shadow: 0 0 8px rgba(122, 155, 110, 0.15);
}

.vq-action--edit:hover {
  color: var(--color-brand);
  border-color: color-mix(in oklab, var(--color-brand) 25%, var(--color-border-default));
}

.vq-action--reject:hover {
  color: var(--color-error);
  border-color: color-mix(in oklab, var(--color-error) 25%, var(--color-border-default));
}

/* Auto-approved badge */
.vq-auto-badge {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 6px;
  background: color-mix(in oklab, var(--color-success) 8%, var(--color-bg-surface));
  border: 1px solid color-mix(in oklab, var(--color-success) 20%, var(--color-border-subtle));
}

.vq-auto-badge svg {
  color: var(--color-success);
  flex-shrink: 0;
}

.vq-auto-badge span {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--color-success);
  white-space: nowrap;
}

/* ── Confidence legend ── */
.vq-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--color-bg-soft);
  border: 1px solid var(--color-border-subtle);
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.5s var(--ease-out-expo), transform 0.5s var(--ease-out-expo);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .vq-legend {
  opacity: 1;
  transform: translateY(0);
}

.vq-legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
}

.vq-legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.vq-legend-dot--high { background: var(--color-success); }
.vq-legend-dot--medium { background: var(--color-warning); }
.vq-legend-dot--low { background: var(--color-error); }

.vq-legend-label {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.vq-legend-desc {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
}

/* ── Audit trail note ── */
.vq-audit {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px dashed var(--color-border-default);
  background: var(--color-bg-soft);
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.5s var(--ease-out-expo), transform 0.5s var(--ease-out-expo);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .vq-audit {
  opacity: 1;
  transform: translateY(0);
}

.vq-audit svg {
  color: var(--color-brand-muted);
  flex-shrink: 0;
}

.vq-audit span {
  font-size: 0.6875rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

/* ── Ambient ── */
.is-visible .vq-item--medium:not(.is-auto) {
  animation: item-attention 3s ease-in-out infinite 2s;
}

@keyframes item-attention {
  0%, 100% { border-color: var(--color-border-default); }
  50% { border-color: color-mix(in oklab, var(--color-warning) 25%, var(--color-border-default)); }
}

.is-visible .vq-item--low:not(.is-auto) {
  animation: item-attention-low 2.5s ease-in-out infinite 2.5s;
}

@keyframes item-attention-low {
  0%, 100% { border-color: var(--color-border-default); }
  50% { border-color: color-mix(in oklab, var(--color-error) 20%, var(--color-border-default)); }
}

@media (max-width: 520px) {
  .vq-item {
    flex-wrap: wrap;
    gap: 8px;
  }

  .vq-item-confidence {
    flex-direction: row;
    width: auto;
  }

  .vq-confidence-bar {
    width: 32px;
    height: 4px;
  }

  .vq-confidence-fill {
    bottom: 0;
    left: 0;
    top: 0;
    right: auto;
    width: var(--confidence);
    height: 100%;
  }

  .vq-item-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
