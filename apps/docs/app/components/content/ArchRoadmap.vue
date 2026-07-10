<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

const visible = ref(false)
const expandedId = ref<number>(0)

onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

function expand(id: number) { expandedId.value = id }
function onKey(e: KeyboardEvent, id: number) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expand(id) }
}

interface Phase {
  id: number
  label: string
  status: 'active' | 'upcoming' | 'planned' | 'future'
  title: string
  ships: string[]
  foundation: string
  icon: string
}

const phases: Phase[] = [
  {
    id: 0,
    label: 'Now',
    status: 'active',
    title: 'Email & Agent Platform',
    ships: ['Email campaigns', 'Transactional', 'Automations', 'Audiences', 'Inbound + agent pipeline', 'Verification queue', 'Knowledge graph', 'File system', 'Team chat', 'Multi-channel store', 'Visualize agent', 'Desktop app'],
    foundation: 'Shipped: sending, audiences, inbound processing, and the agent framework',
    icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  },
  {
    id: 1,
    label: 'Next',
    status: 'upcoming',
    title: 'Wiring the Intelligence',
    ships: ['Automatic knowledge extraction', 'True semantic retrieval', 'File content indexing', 'LLM-synthesized answers'],
    foundation: 'Connecting the built data layer to live extraction and retrieval',
    icon: 'M13 10V3L4 14h7v7l9-11h-7z',
  },
  {
    id: 2,
    label: 'Then',
    status: 'planned',
    title: 'Autonomy & Channels',
    ships: ['Per-category graduated autonomy', 'Autonomy feedback loop', 'Outbound SMS / WhatsApp', 'End-to-end code-work'],
    foundation: 'Graduated trust and outbound on every channel',
    icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
  },
  {
    id: 3,
    label: 'Later',
    status: 'future',
    title: 'The Complete Vision',
    ships: ['Voice', 'Cross-system integrations', 'Relationship intelligence', 'Unified per-contact view'],
    foundation: 'The complete vision',
    icon: 'M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2 2 0 01-2 2H5a2 2 0 01-2-2V5.25A2 2 0 015.25 3h13.5A2 2 0 0121 5.25z',
  },
]

function isFuture(s: string) { return s === 'planned' || s === 'future' }
function statusText(s: string) {
  return s === 'active' ? 'Building now' : s === 'upcoming' ? 'Up next' : s === 'planned' ? 'Planned' : 'Exploring'
}
</script>

<template>
  <div class="rm" :class="{ 'is-visible': visible }">

    <div class="rm-container" role="region" aria-label="Product roadmap">
      <div class="rm-label">
        <span class="rm-label-tag">Roadmap</span>
        <span class="rm-label-sub">What ships and when</span>
      </div>

      <!-- The runway -->
      <div class="rm-runway">
        <div
          v-for="(phase, i) in phases"
          :key="phase.id"
          class="rm-phase"
          :class="[
            `rm-phase--${phase.status}`,
            {
              'is-expanded': expandedId === phase.id,
              'is-collapsed': expandedId !== phase.id,
            }
          ]"
          :style="{ '--i': i, '--depth': i }"
          :tabindex="0"
          :aria-label="`Phase: ${phase.label} — ${phase.title}. ${statusText(phase.status)}. Press Enter to expand.`"
          :aria-expanded="expandedId === phase.id"
          role="article"
          @mouseenter="expand(phase.id)"
          @focus="expand(phase.id)"
          @keydown="onKey($event, phase.id)"
        >
          <!-- Phase number / marker -->
          <div class="rm-marker">
            <span class="rm-marker-num">{{ phase.label }}</span>
            <div v-if="phase.status === 'active'" class="rm-marker-ping" />
          </div>

          <!-- Content column -->
          <div class="rm-content">
            <div class="rm-head">
              <div class="rm-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="phase.icon" /></svg>
              </div>
              <div class="rm-titles">
                <span class="rm-title">{{ phase.title }}</span>
                <span class="rm-status">{{ statusText(phase.status) }}</span>
              </div>
            </div>

            <!-- Detail area: always visible for active/upcoming, animated for future -->
            <div class="rm-detail">
              <div class="rm-ships">
                <span
                  v-for="(item, si) in phase.ships"
                  :key="si"
                  class="rm-ship"
                  :style="{ '--si': si }"
                >{{ item }}</span>
              </div>
              <div class="rm-foundation">{{ phase.foundation }}</div>
            </div>
          </div>

          <!-- Decorative depth line -->
          <div class="rm-depth-edge" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rm {
  margin: 2rem 0;
}

/* ── Container ── */
.rm-container {
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
  background: var(--color-bg-elevated);
  padding: 40px 0 0;
  overflow: hidden;
  position: relative;
  opacity: 0;
  transform: translateY(12px);
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring), border-color var(--motion-moderate);
}

.rm-container::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse at 0% 40%, rgba(196, 120, 90, 0.06) 0%, transparent 50%),
    radial-gradient(ellipse at 100% 60%, rgba(122, 155, 110, 0.04) 0%, transparent 50%);
  pointer-events: none;
}

.is-visible .rm-container {
  opacity: 1;
  transform: translateY(0);
}

.rm-container:hover {
  border-color: var(--color-border-strong);
}

.rm-label {
  position: absolute;
  top: 12px;
  left: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 3;
}

.rm-label-tag {
  font-size: 0.6875rem;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface));
  border: 1px solid color-mix(in oklab, var(--color-brand) 18%, var(--color-border-subtle));
  color: var(--color-brand);
}

.rm-label-sub {
  font-size: 0.625rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

/* ── Runway: the horizontal phase strip ── */
.rm-runway {
  display: flex;
  align-items: stretch;
  min-height: 0;
}

/* ── Phase panels ── */
.rm-phase {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 14px 18px 16px;
  border-right: 1px solid var(--color-border-subtle);
  cursor: default;
  outline: none;
  overflow: hidden;
  flex: var(--phase-flex, 3);
  min-width: 0;

  /* Entrance */
  opacity: 0;
  transform: translateY(10px);
  transition:
    opacity 0.4s var(--ease-spring),
    transform 0.4s var(--ease-spring);
}

.is-visible .rm-phase {
  opacity: 1;
  transform: translateY(0);
}

/* Expanding: width goes first (no delay) */
.rm-phase.is-expanded {
  transition:
    flex 0.4s var(--ease-spring),
    opacity 0.4s var(--ease-spring),
    transform 0.4s var(--ease-spring),
    background 0.3s;
}

/* Collapsing: width waits for content to fade out first */
.rm-phase.is-collapsed {
  transition:
    flex 0.4s var(--ease-spring) 0.15s,
    opacity 0.4s var(--ease-spring),
    transform 0.4s var(--ease-spring),
    background 0.3s;
}

.rm-phase:last-child {
  border-right: none;
}

.rm-phase:focus-visible {
  outline: 2px solid var(--color-brand);
  outline-offset: -2px;
  z-index: 2;
}

/* ── Phase sizing: expanded gets space, collapsed compress ── */
.rm-phase.is-expanded {
  --phase-flex: 5;
  background: color-mix(in oklab, var(--color-brand) 3%, transparent);
}

.rm-phase.is-collapsed {
  --phase-flex: 1;
}

/* Progressive fade for far-future collapsed phases */
.is-visible .rm-phase--planned.is-collapsed { opacity: 0.75; }
.is-visible .rm-phase--future.is-collapsed  { opacity: 0.6; }
.is-visible .rm-phase.is-expanded { opacity: 1; }

/* ── Depth edge: the right-border accent ── */
.rm-depth-edge {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  opacity: 0;
  transition: opacity var(--motion-moderate);
}

.rm-phase.is-expanded .rm-depth-edge {
  background: var(--color-brand);
  opacity: 0.5;
}

.rm-phase--upcoming.is-expanded .rm-depth-edge {
  background: var(--color-info);
}

/* ── Marker ── */
.rm-marker {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  position: relative;
}

.rm-marker-num {
  font-size: 0.5625rem;
  font-weight: 700;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-tertiary);
  padding: 2px 7px;
  border-radius: 3px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  transition: color var(--motion-moderate), background var(--motion-moderate), border-color var(--motion-moderate);
}

.rm-phase--active .rm-marker-num {
  color: var(--color-brand);
  background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface));
  border-color: color-mix(in oklab, var(--color-brand) 25%, var(--color-border-subtle));
}

.rm-phase--upcoming .rm-marker-num {
  color: var(--color-info);
  background: color-mix(in oklab, var(--color-info) 8%, var(--color-bg-surface));
  border-color: color-mix(in oklab, var(--color-info) 20%, var(--color-border-subtle));
}

.rm-marker-ping {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  border-radius: 3px;
  border: 1.5px solid var(--color-brand);
  pointer-events: none;
  opacity: 0;
}

.is-visible .rm-marker-ping {
  animation: rm-ping 2.8s ease-out infinite 1.2s;
}

@keyframes rm-ping {
  0% { transform: scale(1); opacity: 0.5; }
  60% { transform: scale(1.5, 1.8); opacity: 0; }
  100% { transform: scale(1.5, 1.8); opacity: 0; }
}

/* ── Head: icon + titles ── */
.rm-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 10px;
}

.rm-icon {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in oklab, var(--color-brand) 6%, var(--color-bg-elevated));
  color: var(--color-text-secondary);
  transition: color var(--motion-moderate), background var(--motion-moderate), transform var(--motion-moderate) var(--ease-spring);
}

.rm-phase--active .rm-icon {
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
  color: var(--color-brand);
}

.rm-phase--upcoming .rm-icon {
  background: color-mix(in oklab, var(--color-info) 10%, var(--color-bg-surface));
  color: var(--color-info);
}

.rm-phase.is-expanded .rm-icon {
  transform: scale(1.05);
}

/* Smaller icon when collapsed */
.rm-phase.is-collapsed .rm-icon {
  width: 24px;
  height: 24px;
}

.rm-titles {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.rm-title {
  font-weight: var(--font-weight-semibold);
  font-size: 0.875rem;
  color: var(--color-text-primary);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: font-size var(--motion-moderate);
}

.rm-phase.is-collapsed .rm-title {
  font-size: 0.75rem;
}

.rm-status {
  font-size: 0.5625rem;
  font-weight: var(--font-weight-semibold);
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-tertiary);
  transition: color var(--motion-moderate);
}

.rm-phase--active .rm-status {
  color: var(--color-brand);
}

.rm-phase--upcoming .rm-status {
  color: var(--color-info);
}

/* ── Detail: ships + foundation ── */
.rm-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  /* Collapsing: fade out immediately, then hide */
  transition: opacity 0.12s var(--ease-spring), visibility 0s linear 0.12s;
}

.rm-phase.is-expanded .rm-detail {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  /* Expanding: wait for width to finish, then fade in */
  transition: visibility 0s linear var(--motion-slow), opacity var(--motion-moderate) var(--ease-spring) var(--motion-slow);
}

.rm-ships {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.rm-ship {
  font-size: 0.5625rem;
  font-family: var(--font-mono);
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  color: var(--color-text-secondary);
  white-space: nowrap;
  opacity: 0;
  transform: translateY(3px);
  transition: opacity var(--motion-moderate) var(--ease-spring), transform var(--motion-moderate) var(--ease-spring), border-color var(--motion-moderate), background var(--motion-moderate);
}

.is-visible .rm-ship {
  opacity: 1;
  transform: translateY(0);
}

.rm-phase.is-expanded .rm-ship {
  border-color: var(--color-border-default);
}

.rm-foundation {
  font-size: 0.5625rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  line-height: 1.5;
  padding-top: 6px;
  border-top: 1px solid var(--color-border-subtle);
}

/* ── Responsive ── */
@media (max-width: 700px) {
  .rm-runway {
    flex-direction: column;
  }

  .rm-phase {
    flex: none !important;
    border-right: none;
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .rm-phase:last-child {
    border-bottom: none;
  }

  .rm-depth-edge {
    right: auto;
    left: 0;
    top: auto;
    bottom: 0;
    width: auto;
    height: 2px;
  }

  /* Show all details on mobile */
  .rm-phase .rm-detail {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transition: none;
  }

  .rm-phase.is-collapsed .rm-title {
    font-size: 0.875rem;
  }

  .rm-phase.is-collapsed .rm-icon {
    width: 30px;
    height: 30px;
  }
}

/* ── Reduced motion ── */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
</style>
