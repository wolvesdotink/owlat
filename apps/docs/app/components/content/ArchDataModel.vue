<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
const activeEntity = ref<string | null>(null)

onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

type EntityType = 'core' | 'people' | 'contact' | 'channel' | 'content' | 'intelligence'

interface Entity {
  id: string
  type: EntityType
  label: string
  detail: string
}

interface Layer {
  label: string
  sublabel: string
  entities: Entity[]
}

const typeConfig: Record<EntityType, { color: string; icon: string; label: string }> = {
  core: {
    color: 'brand',
    icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
    label: 'Core',
  },
  people: {
    color: 'brand',
    icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
    label: 'People',
  },
  contact: {
    color: 'accent',
    icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
    label: 'Contacts',
  },
  channel: {
    color: 'info',
    icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
    label: 'Communication',
  },
  content: {
    color: 'warning',
    icon: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z',
    label: 'Content',
  },
  intelligence: {
    color: 'success',
    icon: 'M13 10V3L4 14h7v7l9-11h-7z',
    label: 'Intelligence',
  },
}

const layers: Layer[] = [
  {
    label: 'Tenant',
    sublabel: 'Root scope',
    entities: [
      { id: 'org', type: 'core', label: 'Organization', detail: 'Tenant root — all data scoped here' },
    ],
  },
  {
    label: 'Actors & Channels',
    sublabel: 'Participants',
    entities: [
      { id: 'member', type: 'people', label: 'Member', detail: 'Org employees with roles & permissions' },
      { id: 'contact', type: 'contact', label: 'Contact', detail: 'Customers, investors, partners, vendors' },
      { id: 'channel', type: 'channel', label: 'Channel', detail: 'Email, SMS, Chat, Owlat, Webhooks' },
      { id: 'agent', type: 'intelligence', label: 'Agent', detail: 'AI workers — draft, classify, visualize' },
    ],
  },
  {
    label: 'Threads',
    sublabel: 'Universal hub',
    entities: [
      { id: 'conversation', type: 'channel', label: 'Conversation', detail: 'Threaded message stream across channels' },
    ],
  },
  {
    label: 'Artifacts',
    sublabel: 'What conversations produce',
    entities: [
      { id: 'message', type: 'channel', label: 'Message', detail: 'Human or agent authored content' },
      { id: 'file', type: 'content', label: 'File', detail: 'Embedded, tagged, version-tracked' },
      { id: 'knowledge', type: 'intelligence', label: 'Knowledge Node', detail: 'Facts, decisions, events, preferences' },
    ],
  },
]

// Connections between entities (for highlighting)
const connections: Record<string, string[]> = {
  org: ['member', 'contact', 'channel', 'agent'],
  member: ['org', 'conversation', 'agent'],
  contact: ['org', 'conversation', 'knowledge'],
  channel: ['org', 'conversation'],
  agent: ['org', 'conversation', 'knowledge', 'member'],
  conversation: ['member', 'contact', 'channel', 'agent', 'message'],
  message: ['conversation', 'file', 'knowledge'],
  file: ['message', 'knowledge'],
  knowledge: ['message', 'file', 'agent', 'contact'],
}

function isConnected(entityId: string) {
  if (!activeEntity.value) return true
  if (entityId === activeEntity.value) return true
  return connections[activeEntity.value]?.includes(entityId) ?? false
}

const legendTypes = [
  { color: 'brand', label: 'Core & People', icon: typeConfig.core.icon },
  { color: 'accent', label: 'Contacts', icon: typeConfig.contact.icon },
  { color: 'info', label: 'Communication', icon: typeConfig.channel.icon },
  { color: 'warning', label: 'Content', icon: typeConfig.content.icon },
  { color: 'success', label: 'Intelligence', icon: typeConfig.intelligence.icon },
]
</script>

<template>
  <div class="dm" :class="{ 'is-visible': visible }">

    <!-- Layered diagram -->
    <div class="dm-diagram" @mouseleave="activeEntity = null">
      <div class="dm-diagram-label">
        <span class="dm-diagram-label-tag">Data Model</span>
        <span class="dm-diagram-label-sub">Entity relationships</span>
      </div>

      <div class="dm-layers">
        <div
          v-for="(layer, li) in layers"
          :key="layer.label"
          class="dm-layer"
          :style="{ '--li': li }"
        >
          <!-- Layer header -->
          <div class="dm-layer-header">
            <span class="dm-layer-name">{{ layer.label }}</span>
            <span class="dm-layer-sub">{{ layer.sublabel }}</span>
          </div>

          <!-- Entity cards -->
          <div class="dm-layer-entities" :class="{ 'dm-layer-entities--single': layer.entities.length === 1 }">
            <div
              v-for="(entity, ei) in layer.entities"
              :key="entity.id"
              class="dm-entity"
              :class="[
                `dm-entity--${typeConfig[entity.type].color}`,
                {
                  'is-active': activeEntity === entity.id,
                  'is-dimmed': activeEntity !== null && !isConnected(entity.id),
                }
              ]"
              :style="{ '--ei': ei, '--li': li }"
              @mouseenter="activeEntity = entity.id"
            >
              <div class="dm-entity-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="typeConfig[entity.type].icon" /></svg>
              </div>
              <div class="dm-entity-text">
                <div class="dm-entity-top">
                  <span class="dm-entity-type">{{ typeConfig[entity.type].label }}</span>
                </div>
                <span class="dm-entity-label">{{ entity.label }}</span>
                <span class="dm-entity-detail">{{ entity.detail }}</span>
              </div>
            </div>
          </div>

          <!-- Flow arrow between layers -->
          <div v-if="li < layers.length - 1" class="dm-flow-arrow" :style="{ '--li': li }">
            <svg width="16" height="20" viewBox="0 0 16 20" fill="none">
              <path d="M8 0 L8 14 M3 10 L8 16 L13 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
        </div>
      </div>
    </div>

    <!-- Type legend -->
    <div class="dm-types" :style="{ '--stagger': 1 }">
      <div
        v-for="lt in legendTypes"
        :key="lt.color"
        class="dm-type-badge"
        :class="`dm-type-badge--${lt.color}`"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="lt.icon" /></svg>
        <span>{{ lt.label }}</span>
      </div>
    </div>

    <!-- Key design principles -->
    <div class="dm-principles" :style="{ '--stagger': 2 }">
      <div class="dm-principles-header">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
        <span class="dm-principles-title">Key design principles</span>
      </div>
      <div class="dm-principles-grid">
        <div class="dm-principle" :style="{ '--i': 0 }">
          <span class="dm-principle-label">Single tenant root</span>
          <span class="dm-principle-detail">Every entity scoped to Organization — no cross-tenant leakage</span>
        </div>
        <div class="dm-principle" :style="{ '--i': 1 }">
          <span class="dm-principle-label">Conversation as hub</span>
          <span class="dm-principle-detail">Members, Contacts, and Channels all meet in Conversations — the universal thread</span>
        </div>
        <div class="dm-principle" :style="{ '--i': 2 }">
          <span class="dm-principle-label">Knowledge accrues passively</span>
          <span class="dm-principle-detail">Messages, Files, and Contacts automatically feed the Knowledge Graph — no manual entry</span>
        </div>
        <div class="dm-principle" :style="{ '--i': 3 }">
          <span class="dm-principle-label">Agents are first-class actors</span>
          <span class="dm-principle-detail">Agents participate in Conversations, produce Messages, query Knowledge, and ask Members for decisions</span>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.dm {
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ── Diagram container ── */
.dm-diagram {
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
  background: var(--color-bg-elevated);
  padding: 40px 16px 16px;
  overflow: hidden;
  opacity: 0;
  transform: translateY(12px);
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring), border-color var(--motion-moderate);
}

.dm-diagram::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse at 30% 25%, rgba(196, 120, 90, 0.04) 0%, transparent 50%),
    radial-gradient(ellipse at 70% 70%, rgba(107, 143, 168, 0.04) 0%, transparent 50%);
  pointer-events: none;
}

.is-visible .dm-diagram {
  opacity: 1;
  transform: translateY(0);
}

.dm-diagram:hover {
  border-color: var(--color-border-strong);
}

.dm-diagram-label {
  position: absolute;
  top: 12px;
  left: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 2;
}

.dm-diagram-label-tag {
  font-size: 0.6875rem;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface));
  border: 1px solid color-mix(in oklab, var(--color-brand) 18%, var(--color-border-subtle));
  color: var(--color-brand);
}

.dm-diagram-label-sub {
  font-size: 0.625rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

/* ── Layers ── */
.dm-layers {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.dm-layer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(0.15s + var(--li) * 0.1s);
}

.is-visible .dm-layer {
  opacity: 1;
  transform: translateY(0);
}

.dm-layer-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.dm-layer-name {
  font-size: 0.5625rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

.dm-layer-sub {
  font-size: 0.5625rem;
  color: var(--color-text-tertiary);
  opacity: 0.6;
  font-family: var(--font-mono);
}

.dm-layer-sub::before {
  content: '·';
  margin-right: 6px;
}

/* ── Entity cards row ── */
.dm-layer-entities {
  display: flex;
  gap: 8px;
  width: 100%;
  justify-content: center;
}

.dm-layer-entities--single {
  max-width: 320px;
}

/* ── Entity card ── */
.dm-entity {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  flex: 1;
  min-width: 0;
  max-width: 220px;
  cursor: default;
  transition: opacity var(--motion-moderate), border-color var(--motion-moderate), box-shadow var(--motion-moderate), filter var(--motion-moderate), transform var(--motion-moderate);
  opacity: 0;
  transform: translateY(4px);
  animation: dm-entity-enter 0.4s var(--ease-spring) both;
  animation-delay: calc(0.25s + var(--li) * 0.1s + var(--ei) * 0.05s);
}

.is-visible .dm-entity {
  opacity: 1;
  transform: translateY(0);
}

.dm-entity:hover,
.dm-entity.is-active {
  border-color: var(--color-border-default);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  transform: translateY(-1px);
}

.dm-entity.is-dimmed {
  opacity: 0.25;
  filter: grayscale(0.4);
  transform: translateY(0);
}

@keyframes dm-entity-enter {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Color-coded left accent */
.dm-entity--brand { border-left: 2px solid var(--color-brand); }
.dm-entity--accent { border-left: 2px solid var(--color-accent); }
.dm-entity--info { border-left: 2px solid var(--color-info); }
.dm-entity--warning { border-left: 2px solid var(--color-warning); }
.dm-entity--success { border-left: 2px solid var(--color-success); }

.dm-entity--brand.is-active { border-left-color: var(--color-brand); box-shadow: 0 2px 12px color-mix(in oklab, var(--color-brand) 15%, transparent); }
.dm-entity--accent.is-active { border-left-color: var(--color-accent); box-shadow: 0 2px 12px color-mix(in oklab, var(--color-accent) 15%, transparent); }
.dm-entity--info.is-active { border-left-color: var(--color-info); box-shadow: 0 2px 12px color-mix(in oklab, var(--color-info) 15%, transparent); }
.dm-entity--warning.is-active { border-left-color: var(--color-warning); box-shadow: 0 2px 12px color-mix(in oklab, var(--color-warning) 15%, transparent); }
.dm-entity--success.is-active { border-left-color: var(--color-success); box-shadow: 0 2px 12px color-mix(in oklab, var(--color-success) 15%, transparent); }

.dm-entity-icon {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}

.dm-entity--brand .dm-entity-icon { background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface)); color: var(--color-brand); }
.dm-entity--accent .dm-entity-icon { background: color-mix(in oklab, var(--color-accent) 10%, var(--color-bg-surface)); color: var(--color-accent); }
.dm-entity--info .dm-entity-icon { background: color-mix(in oklab, var(--color-info) 10%, var(--color-bg-surface)); color: var(--color-info); }
.dm-entity--warning .dm-entity-icon { background: color-mix(in oklab, var(--color-warning) 10%, var(--color-bg-surface)); color: var(--color-warning); }
.dm-entity--success .dm-entity-icon { background: color-mix(in oklab, var(--color-success) 10%, var(--color-bg-surface)); color: var(--color-success); }

.dm-entity-text {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
}

.dm-entity-top {
  display: flex;
  align-items: center;
  gap: 4px;
}

.dm-entity-type {
  font-size: 0.5625rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.dm-entity--brand .dm-entity-type { color: var(--color-brand); }
.dm-entity--accent .dm-entity-type { color: var(--color-accent); }
.dm-entity--info .dm-entity-type { color: var(--color-info); }
.dm-entity--warning .dm-entity-type { color: var(--color-warning); }
.dm-entity--success .dm-entity-type { color: var(--color-success); }

.dm-entity-label {
  font-weight: var(--font-weight-semibold);
  font-size: 0.75rem;
  color: var(--color-text-primary);
  line-height: 1.3;
}

.dm-entity-detail {
  font-size: 0.5625rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  line-height: 1.4;
}

/* ── Flow arrows between layers ── */
.dm-flow-arrow {
  display: flex;
  justify-content: center;
  padding: 6px 0;
  color: var(--color-border-default);
  opacity: 0;
  transition: opacity var(--motion-slow) var(--ease-spring);
  transition-delay: calc(0.3s + var(--li) * 0.1s);
}

.is-visible .dm-flow-arrow {
  opacity: 0.5;
}

/* ── Type legend ── */
.dm-types {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .dm-types {
  opacity: 1;
  transform: translateY(0);
}

.dm-type-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 5px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  font-size: 0.6875rem;
  font-weight: var(--font-weight-semibold);
  transition: border-color var(--motion-moderate);
}

.dm-type-badge:hover {
  border-color: var(--color-border-default);
}

.dm-type-badge--brand { color: var(--color-brand); border-color: color-mix(in oklab, var(--color-brand) 15%, var(--color-border-subtle)); }
.dm-type-badge--brand svg { color: var(--color-brand); }
.dm-type-badge--accent { color: var(--color-accent); border-color: color-mix(in oklab, var(--color-accent) 15%, var(--color-border-subtle)); }
.dm-type-badge--accent svg { color: var(--color-accent); }
.dm-type-badge--info { color: var(--color-info); border-color: color-mix(in oklab, var(--color-info) 15%, var(--color-border-subtle)); }
.dm-type-badge--info svg { color: var(--color-info); }
.dm-type-badge--warning { color: var(--color-warning); border-color: color-mix(in oklab, var(--color-warning) 15%, var(--color-border-subtle)); }
.dm-type-badge--warning svg { color: var(--color-warning); }
.dm-type-badge--success { color: var(--color-success); border-color: color-mix(in oklab, var(--color-success) 15%, var(--color-border-subtle)); }
.dm-type-badge--success svg { color: var(--color-success); }

/* ── Key design principles ── */
.dm-principles {
  border: 1px solid color-mix(in oklab, var(--color-brand) 20%, var(--color-border-default));
  border-radius: 10px;
  background: var(--color-bg-elevated);
  overflow: hidden;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring), border-color var(--motion-moderate), box-shadow var(--motion-moderate);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .dm-principles {
  opacity: 1;
  transform: translateY(0);
}

.dm-principles:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
}

.dm-principles-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: color-mix(in oklab, var(--color-brand) 3%, var(--color-bg-soft));
}

.dm-principles-header svg {
  color: var(--color-brand);
  flex-shrink: 0;
}

.dm-principles-title {
  font-weight: var(--font-weight-semibold);
  font-size: 0.75rem;
  color: var(--color-brand);
}

.dm-principles-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1px;
  background: var(--color-border-subtle);
}

.dm-principle {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  background: var(--color-bg-elevated);
  opacity: 0;
  transform: translateY(6px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(0.4s + var(--i) * 0.07s);
}

.is-visible .dm-principle {
  opacity: 1;
  transform: translateY(0);
}

.dm-principle-label {
  font-weight: var(--font-weight-semibold);
  font-size: 0.75rem;
  color: var(--color-text-primary);
}

.dm-principle-detail {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  line-height: 1.5;
}

/* ── Responsive ── */
@media (max-width: 600px) {
  .dm-layer-entities {
    flex-wrap: wrap;
  }

  .dm-entity {
    max-width: none;
    flex: 1 1 calc(50% - 4px);
    min-width: 140px;
  }

  .dm-principles-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 480px) {
  .dm-entity {
    flex: 1 1 100%;
  }

  .dm-entity-icon {
    display: none;
  }

  .dm-layer-sub {
    display: none;
  }
}
</style>
