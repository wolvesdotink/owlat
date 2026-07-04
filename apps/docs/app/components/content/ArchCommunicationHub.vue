<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const channels = [
  { name: 'Email', icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
  { name: 'SMS', icon: 'M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z' },
  { name: 'Chat', icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
  { name: 'Webhooks', icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1' },
  { name: 'Owlat', icon: 'M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2 2 0 01-2 2H5a2 2 0 01-2-2V5.25A2 2 0 015.25 3h13.5A2 2 0 0121 5.25z' },
]

const pipelineSteps = [
  { name: 'Context', detail: 'Retrieve' },
  { name: 'Classify', detail: 'Intent' },
  { name: 'Plan', detail: 'Action' },
  { name: 'Draft', detail: 'Generate' },
]

const filterLayers = [
  { name: 'Prompt injection', detail: 'Direct injection, delimiter attacks, role impersonation' },
  { name: 'Instruction smuggling', detail: 'Hidden HTML, invisible text, image alt text' },
  { name: 'Content policy', detail: 'Spam keywords, phishing URLs, prohibited content' },
  { name: 'Metadata stripping', detail: 'HTML → structured text, header filtering' },
]

const knowledgeTypes = [
  { name: 'Facts', color: 'brand' },
  { name: 'Decisions', color: 'accent' },
  { name: 'Events', color: 'info' },
]

const queueActions = [
  { name: 'Approve', icon: 'M5 13l4 4L19 7' },
  { name: 'Edit', icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z' },
  { name: 'Reject', icon: 'M6 18L18 6M6 6l12 12' },
]
</script>

<template>
  <div class="hub" :class="{ 'is-visible': visible }">

    <!-- Row 1: Inbound Channels -->
    <div class="hub-section hub-channels" :style="{ '--stagger': 0 }">
      <div class="hub-section-label">
        <span class="hub-section-tag hub-section-tag--inbound">Inbound</span>
        <span class="hub-section-title">Channel Adapters</span>
      </div>
      <div class="hub-channel-grid">
        <div
          v-for="(ch, i) in channels"
          :key="ch.name"
          class="hub-channel"
          :style="{ '--i': i }"
        >
          <div class="hub-channel-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="ch.icon" /></svg>
          </div>
          <span class="hub-channel-name">{{ ch.name }}</span>
          <div class="hub-channel-pulse" />
        </div>
      </div>
    </div>

    <!-- Connector: Channels → Pipeline -->
    <div class="hub-connector hub-connector--converge" :style="{ '--stagger': 1 }">
      <div class="hub-converge">
        <!-- Vertical drops from each channel -->
        <div class="hub-converge-drop" v-for="i in 5" :key="i" :style="{ '--b': i - 1 }" />
        <!-- Horizontal merge bar -->
        <div class="hub-converge-bar" />
        <!-- Center stem down -->
        <div class="hub-converge-stem" />
        <!-- Animated dots cycling through channels -->
        <div class="hub-converge-dot hub-converge-dot--0" />
        <div class="hub-converge-dot hub-converge-dot--1" />
        <div class="hub-converge-dot hub-converge-dot--2" />
        <div class="hub-converge-dot hub-converge-dot--3" />
        <div class="hub-converge-dot hub-converge-dot--4" />
      </div>
    </div>

    <!-- Content Filter -->
    <div class="hub-section hub-filter" :style="{ '--stagger': 2 }">
      <div class="hub-card hub-card--filter">
        <div class="hub-card-header">
          <div class="hub-card-icon hub-card-icon--filter">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
          </div>
          <div class="hub-card-title">Content Filter</div>
          <div class="hub-filter-badge">
            <span class="hub-filter-badge-dot hub-filter-badge-dot--clean" />
            <span class="hub-filter-badge-label">Pass</span>
            <span class="hub-filter-badge-dot hub-filter-badge-dot--flagged" />
            <span class="hub-filter-badge-label">Quarantine</span>
          </div>
        </div>
        <div class="hub-filter-layers">
          <div
            v-for="(layer, i) in filterLayers"
            :key="layer.name"
            class="hub-filter-layer"
            :style="{ '--fl': i }"
          >
            <span class="hub-filter-layer-num">{{ i + 1 }}</span>
            <div class="hub-filter-layer-text">
              <span class="hub-filter-layer-name">{{ layer.name }}</span>
              <span class="hub-filter-layer-detail">{{ layer.detail }}</span>
            </div>
          </div>
        </div>
        <div class="hub-filter-note">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
          <span>Flagged messages quarantined — admin can release, confirm, or block sender</span>
        </div>
      </div>
    </div>

    <!-- Connector: Filter → Pipeline -->
    <div class="hub-connector hub-connector--single" :style="{ '--stagger': 3 }">
      <div class="hub-connector-line" />
      <div class="hub-connector-label">clean messages only</div>
      <div class="hub-connector-line" />
    </div>

    <!-- Row 2: Agent Pipeline (center) with Knowledge Graph connection -->
    <div class="hub-core" :style="{ '--stagger': 4 }">
      <!-- Knowledge Graph (left) -->
      <div class="hub-knowledge">
        <div class="hub-card hub-card--knowledge">
          <div class="hub-card-header">
            <div class="hub-card-icon hub-card-icon--knowledge">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
            </div>
            <div class="hub-card-title">Knowledge Graph</div>
          </div>
          <div class="hub-knowledge-types">
            <span
              v-for="kt in knowledgeTypes"
              :key="kt.name"
              class="hub-knowledge-tag"
              :class="`hub-knowledge-tag--${kt.color}`"
            >{{ kt.name }}</span>
          </div>
          <div class="hub-knowledge-features">
            <span class="hub-knowledge-feature">Semantic search</span>
            <span class="hub-knowledge-feature">Graph traversal</span>
            <span class="hub-knowledge-feature">Synthesized briefings</span>
          </div>
        </div>
        <!-- Bidirectional connection label -->
        <div class="hub-bidi-label">
          <span class="hub-bidi-arrow">◄</span>
          <span class="hub-bidi-text">context & updates</span>
          <span class="hub-bidi-arrow">►</span>
        </div>
      </div>

      <!-- Agent Pipeline (center) -->
      <div class="hub-card hub-card--pipeline">
        <div class="hub-card-header">
          <div class="hub-card-icon hub-card-icon--pipeline">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
          </div>
          <div class="hub-card-title">Agent Pipeline</div>
        </div>
        <div class="hub-pipeline-steps">
          <div
            v-for="(step, i) in pipelineSteps"
            :key="step.name"
            class="hub-pipeline-step"
            :style="{ '--s': i }"
          >
            <span class="hub-pipeline-step-num">{{ i + 1 }}</span>
            <div class="hub-pipeline-step-text">
              <span class="hub-pipeline-step-name">{{ step.name }}</span>
              <span class="hub-pipeline-step-detail">{{ step.detail }}</span>
            </div>
            <svg v-if="i < pipelineSteps.length - 1" class="hub-pipeline-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7" /></svg>
          </div>
        </div>
        <div class="hub-pipeline-badge">
          <span class="hub-pipeline-badge-dot" />
          Every message processed by an AI agent
        </div>
      </div>
    </div>

    <!-- Connector: Pipeline → Queue -->
    <div class="hub-connector hub-connector--single" :style="{ '--stagger': 5 }">
      <div class="hub-connector-line" />
      <div class="hub-connector-label">draft + confidence score</div>
      <div class="hub-connector-line" />
      <div class="hub-connector-flow-dot" />
    </div>

    <!-- Row 3: Verification Queue -->
    <div class="hub-section" :style="{ '--stagger': 6 }">
      <div class="hub-card hub-card--queue">
        <div class="hub-card-header">
          <div class="hub-card-icon hub-card-icon--queue">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          </div>
          <div class="hub-card-title">Verification Queue</div>
          <div class="hub-queue-confidence">
            <span class="hub-confidence-dot hub-confidence-dot--high" />
            <span class="hub-confidence-label">Auto</span>
            <span class="hub-confidence-dot hub-confidence-dot--medium" />
            <span class="hub-confidence-label">Review</span>
            <span class="hub-confidence-dot hub-confidence-dot--low" />
            <span class="hub-confidence-label">Escalate</span>
          </div>
        </div>
        <div class="hub-queue-content">
          <div class="hub-queue-description">
            <span>Org members see a prioritized list of verifications and approvals</span>
          </div>
          <div class="hub-queue-actions">
            <div
              v-for="action in queueActions"
              :key="action.name"
              class="hub-queue-action"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="action.icon" /></svg>
              <span>{{ action.name }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Connector: Queue → Outbound -->
    <div class="hub-connector hub-connector--queue-out" :style="{ '--stagger': 7 }">
      <div class="hub-connector-line" />
    </div>

    <!-- Row 4: Outbound + Knowledge Feedback -->
    <div class="hub-output-row" :style="{ '--stagger': 8 }">
      <div class="hub-card hub-card--outbound">
        <div class="hub-card-icon hub-card-icon--outbound">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
        </div>
        <div class="hub-outbound-text">
          <span class="hub-card-title">Outbound Delivery</span>
          <span class="hub-outbound-detail">Route to correct channel</span>
        </div>
      </div>
      <div class="hub-feedback">
        <div class="hub-feedback-line" />
        <div class="hub-feedback-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
          <span>Knowledge updated</span>
        </div>
      </div>
    </div>

    <!-- Tenant isolation badge -->
    <div class="hub-isolation" :style="{ '--stagger': 9 }">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
      <span>Strict tenant isolation — every operation scoped to a single organization</span>
    </div>

  </div>
</template>

<style scoped>
.hub {
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0;
}

/* ── Sections (generic wrapper) ── */
.hub-section {
  opacity: 0;
  transform: translateY(14px);
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .hub-section {
  opacity: 1;
  transform: translateY(0);
}

.hub-section-label {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.hub-section-tag {
  font-size: 0.625rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 2px 8px;
  border-radius: 4px;
  line-height: 1.6;
}

.hub-section-tag--inbound {
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
  color: var(--color-brand);
  border: 1px solid color-mix(in oklab, var(--color-brand) 20%, var(--color-border-subtle));
}

.hub-section-title {
  font-size: 0.75rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

/* ── Channel cards ── */
.hub-channel-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
}

@media (max-width: 600px) {
  .hub-channel-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

@media (max-width: 400px) {
  .hub-channel-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

.hub-channel {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-default);
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring), border-color var(--motion-moderate), box-shadow var(--motion-moderate);
  transition-delay: calc(0.1s + var(--i) * 0.06s);
}

.is-visible .hub-channel {
  opacity: 1;
  transform: translateY(0);
}

.hub-channel:hover {
  border-color: color-mix(in oklab, var(--color-brand) 30%, var(--color-border-default));
  box-shadow: 0 2px 12px rgba(196, 120, 90, 0.08);
  transition-delay: 0s;
}

.hub-channel-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 7px;
  background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface));
  color: var(--color-brand);
  flex-shrink: 0;
  transition: box-shadow var(--motion-moderate);
}

.hub-channel:hover .hub-channel-icon {
  box-shadow: 0 0 10px rgba(196, 120, 90, 0.15);
}

.hub-channel-name {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
}

.hub-channel-pulse {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-success);
}

.is-visible .hub-channel-pulse {
  animation: channel-pulse 2.5s ease-in-out infinite;
  animation-delay: calc(var(--i) * 0.4s + 1s);
}

@keyframes channel-pulse {
  0%, 100% { opacity: 0.4; box-shadow: 0 0 0 0 transparent; }
  50% { opacity: 1; box-shadow: 0 0 6px 2px rgba(122, 155, 110, 0.3); }
}

/* ── Connectors ── */
.hub-connector {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 0;
  opacity: 0;
  transition: opacity var(--motion-slow) var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.12s);
  position: relative;
}

.is-visible .hub-connector {
  opacity: 1;
}

.hub-connector-line {
  width: 2px;
  height: 16px;
  background: linear-gradient(to bottom, var(--color-brand-dim), var(--color-border-strong));
  border-radius: 1px;
  transform-origin: top;
}

.is-visible .hub-connector-line {
  animation: line-draw 0.5s var(--ease-spring) both;
  animation-delay: calc(var(--stagger) * 0.12s + 0.2s);
}

@keyframes line-draw {
  from { transform: scaleY(0); }
  to { transform: scaleY(1); }
}

.hub-connector-label {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  padding: 3px 12px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: 4px;
  white-space: nowrap;
}

/* Converging connector (channels → pipeline) */
.hub-connector--converge {
  padding: 6px 0 24px;
}

.hub-converge {
  position: relative;
  width: 100%;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
  /* Column center positions accounting for gaps: center = col * (colWidth + gap) + colWidth/2 */
  --cg: 8px;
  --cw: calc((100% - 4 * var(--cg)) / 5);
  --c0: calc(var(--cw) / 2);
  --c1: calc(var(--cw) * 1.5 + var(--cg));
  --c2: calc(var(--cw) * 2.5 + 2 * var(--cg));
  --c3: calc(var(--cw) * 3.5 + 3 * var(--cg));
  --c4: calc(var(--cw) * 4.5 + 4 * var(--cg));
  /* Stem target: center of the pipeline card area (between c2 and c4) */
  --stem: calc((var(--c2) + var(--c4)) / 2);
}

/* Vertical drops — one under each channel card */
.hub-converge-drop {
  height: 16px;
  position: relative;
}

.hub-converge-drop::after {
  content: '';
  position: absolute;
  left: calc(50% - 1px);
  top: 0;
  width: 2px;
  height: calc(100% + 2px);
  background: var(--color-border-strong);
  transform-origin: top;
  border-radius: 1px;
}

.is-visible .hub-converge-drop::after {
  animation: line-draw 0.4s var(--ease-spring) both;
  animation-delay: calc(var(--b) * 0.05s + 0.15s);
}

/* Horizontal merge bar spanning full width */
.hub-converge-bar {
  position: absolute;
  top: 16px;
  left: calc(var(--c0) - 1px);
  right: calc(100% - var(--c4) - 1px);
  height: 2px;
  background: var(--color-border-strong);
  border-radius: 1px;
}

/* Center stem going down — aligned to pipeline card center */
.hub-converge-stem {
  position: absolute;
  top: 16px;
  left: var(--stem);
  width: 2px;
  height: 14px;
  background: var(--color-border-strong);
  transform: translateX(-50%);
  border-radius: 1px;
}

/* Animated dots — each starts from a different channel, travels down + across + down */
.hub-converge-dot {
  position: absolute;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-brand);
  opacity: 0;
  pointer-events: none;
  top: 0;
}

/* Dot 0: Email (1st column center) */
.hub-converge-dot--0 {
  left: calc(var(--c0) - 2.5px);
}

.is-visible .hub-converge-dot--0 {
  animation: dot-ch0 10s linear infinite 1.5s;
}

/* Dot 1: SMS (2nd column center) */
.hub-converge-dot--1 {
  left: calc(var(--c1) - 2.5px);
}

.is-visible .hub-converge-dot--1 {
  animation: dot-ch1 10s linear infinite 3.5s;
}

/* Dot 2: Chat (3rd column center) */
.hub-converge-dot--2 {
  left: calc(var(--c2) - 2.5px);
}

.is-visible .hub-converge-dot--2 {
  animation: dot-ch2 10s linear infinite 5.5s;
}

/* Dot 3: Webhooks (4th column center) */
.hub-converge-dot--3 {
  left: calc(var(--c3) - 2.5px);
}

.is-visible .hub-converge-dot--3 {
  animation: dot-ch3 10s linear infinite 7.5s;
}

/* Dot 4: Owlat (5th column center) */
.hub-converge-dot--4 {
  left: calc(var(--c4) - 2.5px);
}

.is-visible .hub-converge-dot--4 {
  animation: dot-ch4 10s linear infinite 9.5s;
}

/* Each dot: 3-phase L-path. Down to bar, across to stem, down the stem. */

/* Email (col 0 → stem): down, then RIGHT, then down */
@keyframes dot-ch0 {
  0%    { top: 0;    left: calc(var(--c0) - 2.5px); opacity: 0; }
  2%    { top: 0;    left: calc(var(--c0) - 2.5px); opacity: 1; }
  8%    { top: 14px; left: calc(var(--c0) - 2.5px); opacity: 1; }
  8.01% { top: 14px; left: calc(var(--c0) - 2.5px); opacity: 1; }
  16%   { top: 14px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  16.01%{ top: 14px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  24%   { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  26%   { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 0; }
  100%  { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 0; }
}

/* SMS (col 1 → stem): down, then RIGHT, then down */
@keyframes dot-ch1 {
  0%    { top: 0;    left: calc(var(--c1) - 2.5px); opacity: 0; }
  2%    { top: 0;    left: calc(var(--c1) - 2.5px); opacity: 1; }
  8%    { top: 14px; left: calc(var(--c1) - 2.5px); opacity: 1; }
  8.01% { top: 14px; left: calc(var(--c1) - 2.5px); opacity: 1; }
  16%   { top: 14px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  16.01%{ top: 14px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  24%   { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  26%   { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 0; }
  100%  { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 0; }
}

/* Chat (col 2 → stem): down, then RIGHT, then down */
@keyframes dot-ch2 {
  0%    { top: 0;    left: calc(var(--c2) - 2.5px); opacity: 0; }
  2%    { top: 0;    left: calc(var(--c2) - 2.5px); opacity: 1; }
  8%    { top: 14px; left: calc(var(--c2) - 2.5px); opacity: 1; }
  8.01% { top: 14px; left: calc(var(--c2) - 2.5px); opacity: 1; }
  16%   { top: 14px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  16.01%{ top: 14px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  24%   { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  26%   { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 0; }
  100%  { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 0; }
}

/* Webhooks (col 3 → stem): down, then LEFT, then down */
@keyframes dot-ch3 {
  0%    { top: 0;    left: calc(var(--c3) - 2.5px); opacity: 0; }
  2%    { top: 0;    left: calc(var(--c3) - 2.5px); opacity: 1; }
  8%    { top: 14px; left: calc(var(--c3) - 2.5px); opacity: 1; }
  8.01% { top: 14px; left: calc(var(--c3) - 2.5px); opacity: 1; }
  16%   { top: 14px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  16.01%{ top: 14px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  24%   { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  26%   { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 0; }
  100%  { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 0; }
}

/* Owlat (col 4 → stem): down, then LEFT, then down */
@keyframes dot-ch4 {
  0%    { top: 0;    left: calc(var(--c4) - 2.5px); opacity: 0; }
  2%    { top: 0;    left: calc(var(--c4) - 2.5px); opacity: 1; }
  8%    { top: 14px; left: calc(var(--c4) - 2.5px); opacity: 1; }
  8.01% { top: 14px; left: calc(var(--c4) - 2.5px); opacity: 1; }
  16%   { top: 14px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  16.01%{ top: 14px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  24%   { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 1; }
  26%   { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 0; }
  100%  { top: 30px; left: calc(var(--stem) - 2.5px); opacity: 0; }
}

/* Single connector (pipeline → queue) — offset to align with pipeline center */
.hub-connector--single {
  /* Use same column math as converge: stem sits between c2 and c4 */
  --cg: 8px;
  --cw: calc((100% - 4 * var(--cg)) / 5);
  --c2: calc(var(--cw) * 2.5 + 2 * var(--cg));
  --c4: calc(var(--cw) * 4.5 + 4 * var(--cg));
  --stem: calc((var(--c2) + var(--c4)) / 2);
  align-items: stretch;
  position: relative;
}

.hub-connector--single .hub-connector-line,
.hub-connector--single .hub-connector-label {
  margin-left: var(--stem);
  transform: translateX(-50%);
}

.hub-connector--single .hub-connector-label {
  width: fit-content;
}

/* Simple connector (queue → outbound) */
.hub-connector--queue-out .hub-connector-line {
  height: 24px;
}

/* ── Core area (Knowledge Graph + Pipeline side by side) ── */
.hub-core {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0;
  align-items: stretch;
  opacity: 0;
  transform: translateY(14px);
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .hub-core {
  opacity: 1;
  transform: translateY(0);
}

@media (max-width: 640px) {
  .hub-core {
    grid-template-columns: 1fr;
  }
}

/* ── Cards ── */
.hub-card {
  border: 1px solid var(--color-border-default);
  border-radius: 10px;
  background: var(--color-bg-elevated);
  padding: 14px 16px;
  position: relative;
  overflow: hidden;
  transition: border-color var(--motion-moderate), box-shadow var(--motion-moderate);
}

.hub-card::before {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity var(--motion-slow);
  pointer-events: none;
}

.hub-card:hover::before {
  opacity: 1;
}

.hub-card:hover {
  border-color: var(--color-border-strong);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.hub-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.hub-card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  flex-shrink: 0;
  transition: box-shadow var(--motion-moderate);
}

.hub-card:hover .hub-card-icon {
  box-shadow: 0 0 10px rgba(196, 120, 90, 0.12);
}

.hub-card-title {
  font-weight: 600;
  font-size: 0.875rem;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
}

/* ── Knowledge Graph card ── */
.hub-knowledge {
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

.hub-card--knowledge {
  border-color: color-mix(in oklab, var(--color-accent) 20%, var(--color-border-default));
}

.hub-card--knowledge::before {
  background: radial-gradient(ellipse at 30% 40%, rgba(212, 165, 116, 0.06) 0%, transparent 70%);
}

.hub-card--knowledge .hub-card-title {
  color: var(--color-accent);
}

.hub-card-icon--knowledge {
  background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface));
  color: var(--color-accent);
}

.hub-knowledge-types {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 10px;
}

.hub-knowledge-tag {
  font-size: 0.6875rem;
  font-family: var(--font-mono);
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface);
  color: var(--color-text-secondary);
}

.hub-knowledge-tag--brand { color: var(--color-brand); border-color: color-mix(in oklab, var(--color-brand) 20%, var(--color-border-subtle)); }
.hub-knowledge-tag--accent { color: var(--color-accent); border-color: color-mix(in oklab, var(--color-accent) 20%, var(--color-border-subtle)); }
.hub-knowledge-tag--info { color: var(--color-info); border-color: color-mix(in oklab, var(--color-info) 20%, var(--color-border-subtle)); }

.hub-knowledge-features {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.hub-knowledge-feature {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  padding-left: 12px;
  position: relative;
}

.hub-knowledge-feature::before {
  content: '›';
  position: absolute;
  left: 0;
  color: var(--color-accent-muted);
  font-weight: 600;
}

/* Bidirectional label between knowledge and pipeline */
.hub-bidi-label {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 0;
  margin: 0;
}

.hub-bidi-arrow {
  font-size: 0.625rem;
  color: var(--color-brand-dim);
  line-height: 1;
}

.is-visible .hub-bidi-arrow {
  animation: bidi-pulse 2s ease-in-out infinite;
}

.hub-bidi-arrow:last-child {
  animation-delay: 1s;
}

@keyframes bidi-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

.hub-bidi-text {
  font-size: 0.625rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  white-space: nowrap;
}

@media (max-width: 640px) {
  .hub-bidi-label {
    padding: 4px 0;
  }
}

@media (min-width: 641px) {
  .hub-knowledge {
    flex-direction: row;
    align-items: center;
  }

  .hub-bidi-label {
    flex-direction: column;
    padding: 0 8px;
  }

  .hub-bidi-arrow {
    transform: rotate(0deg);
  }
}

/* ── Agent Pipeline card ── */
.hub-card--pipeline {
  border-color: color-mix(in oklab, var(--color-brand) 25%, var(--color-border-default));
}

.hub-card--pipeline::before {
  background: radial-gradient(ellipse at 50% 30%, rgba(196, 120, 90, 0.05) 0%, transparent 70%);
}

.hub-card--pipeline .hub-card-title {
  color: var(--color-brand);
}

.hub-card-icon--pipeline {
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
  color: var(--color-brand);
}

.hub-pipeline-steps {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.hub-pipeline-step {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  transition: border-color var(--motion-moderate), background var(--motion-moderate);
  opacity: 0;
  transform: translateX(-6px);
}

.is-visible .hub-pipeline-step {
  opacity: 1;
  transform: translateX(0);
  transition: border-color var(--motion-moderate), background var(--motion-moderate), opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(0.3s + var(--s) * 0.08s);
}

.hub-pipeline-step:hover {
  border-color: color-mix(in oklab, var(--color-brand) 25%, var(--color-border-default));
  background: var(--color-bg-surface-hover);
}

.hub-pipeline-step-num {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: color-mix(in oklab, var(--color-brand) 15%, var(--color-bg-elevated));
  color: var(--color-brand);
  font-size: 0.625rem;
  font-weight: 700;
  flex-shrink: 0;
}

.hub-pipeline-step-text {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.hub-pipeline-step-name {
  font-weight: 600;
  font-size: 0.75rem;
  color: var(--color-text-primary);
  line-height: 1.3;
}

.hub-pipeline-step-detail {
  font-size: 0.625rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  line-height: 1.3;
}

.hub-pipeline-arrow {
  color: var(--color-text-disabled);
  flex-shrink: 0;
}

.is-visible .hub-pipeline-arrow {
  animation-delay: calc(var(--s) * 0.3s + 1.5s);
}


.hub-pipeline-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--color-border-subtle);
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
}

.hub-pipeline-badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-brand);
  flex-shrink: 0;
}

.is-visible .hub-pipeline-badge-dot {
  animation: badge-dot-pulse 2s ease-in-out infinite 2s;
}

@keyframes badge-dot-pulse {
  0%, 100% { box-shadow: 0 0 0 0 transparent; }
  50% { box-shadow: 0 0 6px 2px rgba(196, 120, 90, 0.25); }
}

/* ── Content Filter card ── */
.hub-card--filter {
  border-color: color-mix(in oklab, var(--color-warning) 20%, var(--color-border-default));
}

.hub-card--filter::before {
  background: radial-gradient(ellipse at 40% 30%, rgba(201, 165, 90, 0.05) 0%, transparent 70%);
}

.hub-card--filter .hub-card-title {
  color: var(--color-warning);
}

.hub-card-icon--filter {
  background: color-mix(in oklab, var(--color-warning) 12%, var(--color-bg-surface));
  color: var(--color-warning);
}

.hub-filter-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: 0.625rem;
  font-family: var(--font-mono);
}

.hub-filter-badge-label {
  color: var(--color-text-tertiary);
}

.hub-filter-badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.hub-filter-badge-dot--clean {
  background: var(--color-success);
}

.hub-filter-badge-dot--flagged {
  background: var(--color-error);
}

.hub-filter-layers {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
  margin-bottom: 10px;
}

@media (max-width: 500px) {
  .hub-filter-layers {
    grid-template-columns: 1fr;
  }
}

.hub-filter-layer {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  transition: border-color var(--motion-moderate);
}

.hub-filter-layer:hover {
  border-color: color-mix(in oklab, var(--color-warning) 25%, var(--color-border-default));
}

.hub-filter-layer-num {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: color-mix(in oklab, var(--color-warning) 12%, var(--color-bg-elevated));
  font-size: 0.5625rem;
  font-weight: 700;
  color: var(--color-warning);
  flex-shrink: 0;
  margin-top: 1px;
}

.hub-filter-layer-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.hub-filter-layer-name {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.hub-filter-layer-detail {
  font-size: 0.625rem;
  color: var(--color-text-tertiary);
  line-height: 1.4;
}

.hub-filter-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border-subtle);
}

.hub-filter-note svg {
  color: var(--color-warning-muted, var(--color-warning));
  flex-shrink: 0;
  margin-top: 1px;
  opacity: 0.7;
}

.hub-filter-note span {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  line-height: 1.5;
}

/* ── Verification Queue card ── */
.hub-card--queue {
  border-color: color-mix(in oklab, var(--color-success) 20%, var(--color-border-default));
}

.hub-card--queue::before {
  background: radial-gradient(ellipse at 60% 30%, rgba(122, 155, 110, 0.05) 0%, transparent 70%);
}

.hub-card--queue .hub-card-title {
  color: var(--color-success);
}

.hub-card-icon--queue {
  background: color-mix(in oklab, var(--color-success) 12%, var(--color-bg-surface));
  color: var(--color-success);
}

.hub-queue-confidence {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 3px 10px;
  border-radius: 5px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
}

.hub-confidence-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.hub-confidence-dot--high { background: var(--color-success); }
.hub-confidence-dot--medium { background: var(--color-warning); }
.hub-confidence-dot--low { background: var(--color-error); }

.hub-confidence-label {
  font-size: 0.625rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  margin-right: 6px;
}

.hub-confidence-label:last-child {
  margin-right: 0;
}

.hub-queue-content {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.hub-queue-description {
  flex: 1;
  min-width: 200px;
}

.hub-queue-description span {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.hub-queue-actions {
  display: flex;
  gap: 6px;
}

.hub-queue-action {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 6px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  font-size: 0.6875rem;
  font-weight: 500;
  color: var(--color-text-secondary);
  transition: border-color var(--motion-moderate), color var(--motion-moderate), background var(--motion-moderate);
  cursor: default;
}

.hub-queue-action:first-child {
  color: var(--color-success);
  border-color: color-mix(in oklab, var(--color-success) 20%, var(--color-border-subtle));
}

.hub-queue-action:hover {
  background: var(--color-bg-surface-hover);
  border-color: var(--color-border-default);
}

/* ── Output row ── */
.hub-output-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  align-items: center;
  opacity: 0;
  transform: translateY(12px);
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .hub-output-row {
  opacity: 1;
  transform: translateY(0);
}

@media (max-width: 480px) {
  .hub-output-row {
    grid-template-columns: 1fr;
  }
}

.hub-card--outbound {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
}

.hub-card--outbound::before {
  background: radial-gradient(ellipse at 20% 50%, rgba(196, 120, 90, 0.04) 0%, transparent 70%);
}

.hub-card-icon--outbound {
  background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface));
  color: var(--color-brand);
}

.hub-outbound-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.hub-outbound-detail {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

/* Feedback loop */
.hub-feedback {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hub-feedback-line {
  width: 20px;
  height: 2px;
  background: var(--color-border-strong);
  border-radius: 1px;
}

.hub-feedback-label {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 6px;
  background: var(--color-bg-surface);
  border: 1px dashed color-mix(in oklab, var(--color-accent) 30%, var(--color-border-default));
  white-space: nowrap;
}

.hub-feedback-label svg {
  color: var(--color-accent-muted);
  flex-shrink: 0;
}

.is-visible .hub-feedback-label svg {
  animation: feedback-spin 3s ease-in-out infinite 2.5s;
}

@keyframes feedback-spin {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(-15deg); }
  75% { transform: rotate(15deg); }
}

.hub-feedback-label span {
  font-size: 0.6875rem;
  color: var(--color-accent-muted);
  font-family: var(--font-mono);
}

/* ── Tenant isolation badge ── */
.hub-isolation {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid color-mix(in oklab, var(--color-warning) 15%, var(--color-border-default));
  background: color-mix(in oklab, var(--color-warning) 3%, var(--color-bg-soft));
  opacity: 0;
  transform: translateY(10px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .hub-isolation {
  opacity: 1;
  transform: translateY(0);
}

.hub-isolation svg {
  color: var(--color-warning);
  flex-shrink: 0;
}

.hub-isolation span {
  font-size: 0.6875rem;
  color: var(--color-text-secondary);
}






</style>
