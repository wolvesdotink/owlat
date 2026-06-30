<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

interface ScopeItem {
  name: string
  path: string
  tech: string
  desc: string
  icon: string
}

const apps: ScopeItem[] = [
  {
    name: 'web',
    path: 'apps/web',
    tech: 'Nuxt 4 + Vue 3',
    desc: 'Main dashboard — email builder, campaigns, audience, automations, settings',
    icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1',
  },
  {
    name: 'api',
    path: 'apps/api',
    tech: 'Convex',
    desc: 'Serverless backend — database, auth, real-time subscriptions, cron jobs',
    icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01',
  },
  {
    name: 'mta',
    path: 'apps/mta',
    tech: 'Hono + GroupMQ',
    desc: 'Mail Transfer Agent — direct SMTP delivery, IP warming, bounce processing',
    icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  },
  {
    name: 'imap',
    path: 'apps/imap',
    tech: 'Node + IMAP',
    desc: 'IMAP server (port 993) — maps IMAP4rev1 onto Convex per-user mailboxes',
    icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  },
  {
    name: 'mail-sync',
    path: 'apps/mail-sync',
    tech: 'Node worker',
    desc: 'Syncs external IMAP/SMTP accounts — inbound via IMAP IDLE, relays outbound',
    icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  },
  {
    name: 'code-worker',
    path: 'apps/code-worker',
    tech: 'Node worker',
    desc: 'Polls Convex for queued code tasks and runs them (GitHub task runner)',
    icon: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
  },
  {
    name: 'desktop',
    path: 'apps/desktop',
    tech: 'Tauri 2 + Rust',
    desc: 'Desktop shell — bundles the web SPA, connects to one or more deployments',
    icon: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  },
  {
    name: 'setup-cli',
    path: 'apps/setup-cli',
    tech: 'TypeScript · Bun',
    desc: 'Self-host setup CLI — the owlat quickstart installer for a full instance',
    icon: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  },
  {
    name: 'updater',
    path: 'apps/updater',
    tech: 'Node',
    desc: 'Self-host update worker — applies Docker Compose updates over HTTP',
    icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  },
  {
    name: 'docs',
    path: 'apps/docs',
    tech: 'Nuxt + Content',
    desc: 'Developer documentation — guides, API reference, architecture docs',
    icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
  },
  {
    name: 'marketing',
    path: 'apps/marketing',
    tech: 'Nuxt',
    desc: 'Public website — landing pages, pricing, changelog',
    icon: 'M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z',
  },
]

const packages: ScopeItem[] = [
  {
    name: 'shared',
    path: 'packages/shared',
    tech: 'TypeScript',
    desc: 'Shared types — block definitions, editor types, compatibility data',
    icon: 'M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z',
  },
  {
    name: 'email-renderer',
    path: 'packages/email-renderer',
    tech: 'TypeScript',
    desc: 'Email HTML engine — table layouts, VML, CSS inlining, dark mode, AMP',
    icon: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
  },
  {
    name: 'email-builder',
    path: 'packages/email-builder',
    tech: 'Vue 3',
    desc: 'Notion-like editor — drag-and-drop canvas, block settings, slash commands',
    icon: 'M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z',
  },
  {
    name: 'email-previewer',
    path: 'packages/email-previewer',
    tech: 'Vue 3',
    desc: 'Preview & analysis — cross-client rendering, compatibility scoring, diffs',
    icon: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
  },
  {
    name: 'email-scanner',
    path: 'packages/email-scanner',
    tech: 'TypeScript',
    desc: 'Email security — spam/phishing detection, file validation, ClamAV, URL reputation',
    icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
  },
  {
    name: 'channels',
    path: 'packages/channels',
    tech: 'TypeScript',
    desc: 'Multi-channel adapters — email, SMS, WhatsApp, generic webhook, native chat',
    icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
  },
  {
    name: 'ui',
    path: 'packages/ui',
    tech: 'Nuxt Layer',
    desc: 'Component library — toast notifications, error boundaries, shared composables',
    icon: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm0 8a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zm12 0a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z',
  },
  {
    name: 'sdk-js',
    path: 'packages/sdk-js',
    tech: 'TypeScript · npm',
    desc: 'JavaScript SDK — contacts, transactional sends, events, topics',
    icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  },
  {
    name: 'sdk-java',
    path: 'packages/sdk-java',
    tech: 'Java · Maven',
    desc: 'Java SDK — same API surface, JVM-native client',
    icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  },
]

interface Connection {
  from: string
  to: string
  label: string
  dashed?: boolean
}

const connections: Connection[] = [
  { from: 'web', to: 'api', label: 'Real-time queries & mutations' },
  { from: 'api', to: 'mta', label: 'Email delivery' },
  { from: 'web', to: 'email-builder', label: 'Editor UI', dashed: true },
  { from: 'web', to: 'email-previewer', label: 'Preview', dashed: true },
  { from: 'web', to: 'ui', label: 'Components', dashed: true },
  { from: 'api', to: 'email-renderer', label: 'HTML generation', dashed: true },
  { from: 'api', to: 'email-scanner', label: 'Security scanning', dashed: true },
  { from: 'web', to: 'email-renderer', label: 'Live preview', dashed: true },
  { from: 'api', to: 'shared', label: 'Types', dashed: true },
]

const activeConnection = ref<Connection | null>(null)

function isHighlighted(name: string): boolean {
  if (!activeConnection.value) return false
  return activeConnection.value.from === name || activeConnection.value.to === name
}
</script>

<template>
  <div class="scope-map" :class="{ 'is-visible': visible }">
    <!-- Apps section -->
    <div class="scope-section" :style="{ '--stagger': 0 }">
      <div class="scope-section-header">
        <span class="scope-section-label scope-section-label--brand">Applications</span>
        <span class="scope-section-count">{{ apps.length }} apps</span>
      </div>
      <div class="scope-grid scope-grid--apps">
        <div
          v-for="(app, i) in apps"
          :key="app.name"
          class="scope-card scope-card--brand"
          :class="{ 'scope-card--highlighted': isHighlighted(app.name) }"
          :style="{ '--item-stagger': i }"
        >
          <div class="scope-card-icon scope-card-icon--brand">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="app.icon" /></svg>
          </div>
          <div class="scope-card-body">
            <div class="scope-card-header">
              <span class="scope-card-name">{{ app.name }}</span>
              <span class="scope-card-tech">{{ app.tech }}</span>
            </div>
            <span class="scope-card-desc">{{ app.desc }}</span>
            <span class="scope-card-path">{{ app.path }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Connection strip -->
    <div class="scope-connections" :style="{ '--stagger': 1 }">
      <div class="scope-connections-line" />
      <div class="scope-connections-labels">
        <div
          v-for="conn in connections"
          :key="`${conn.from}-${conn.to}`"
          class="scope-conn-tag"
          :class="{ 'scope-conn-tag--dashed': conn.dashed, 'scope-conn-tag--active': activeConnection === conn }"
          @mouseenter="activeConnection = conn"
          @mouseleave="activeConnection = null"
        >
          <span class="scope-conn-from">{{ conn.from }}</span>
          <svg class="scope-conn-arrow" width="12" height="8" viewBox="0 0 12 8" fill="none">
            <path d="M1 4h10m0 0L8 1m3 3L8 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="scope-conn-to">{{ conn.to }}</span>
          <span class="scope-conn-label">{{ conn.label }}</span>
        </div>
      </div>
      <div class="scope-connections-line" />
    </div>

    <!-- Packages section -->
    <div class="scope-section" :style="{ '--stagger': 2 }">
      <div class="scope-section-header">
        <span class="scope-section-label scope-section-label--accent">Packages</span>
        <span class="scope-section-count">{{ packages.length }} packages</span>
      </div>
      <div class="scope-grid scope-grid--packages">
        <div
          v-for="(pkg, i) in packages"
          :key="pkg.name"
          class="scope-card scope-card--accent"
          :class="{ 'scope-card--highlighted': isHighlighted(pkg.name) }"
          :style="{ '--item-stagger': apps.length + i }"
        >
          <div class="scope-card-icon scope-card-icon--accent">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="pkg.icon" /></svg>
          </div>
          <div class="scope-card-body">
            <div class="scope-card-header">
              <span class="scope-card-name">{{ pkg.name }}</span>
              <span class="scope-card-tech">{{ pkg.tech }}</span>
            </div>
            <span class="scope-card-desc">{{ pkg.desc }}</span>
            <span class="scope-card-path">{{ pkg.path }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Shared dependency note -->
    <div class="scope-shared-note" :style="{ '--stagger': 3 }">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
      <span>All packages import from <code>shared</code> for block types, editor types, and compatibility data.</span>
    </div>
  </div>
</template>

<style scoped>
.scope-map {
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* ── Sections ── */
.scope-section {
  opacity: 0;
  transform: translateY(16px);
  transition: opacity 0.6s var(--ease-out-expo), transform 0.6s var(--ease-out-expo);
  transition-delay: calc(var(--stagger) * 0.18s);
}

.is-visible .scope-section {
  opacity: 1;
  transform: translateY(0);
}

.scope-section-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
}

.scope-section-label {
  font-weight: 600;
  font-size: 0.9375rem;
  letter-spacing: -0.01em;
}

.scope-section-label--brand { color: var(--color-brand); }
.scope-section-label--accent { color: var(--color-accent); }

.scope-section-count {
  font-size: 0.75rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

/* ── Grid ── */
.scope-grid {
  display: grid;
  gap: 10px;
}

.scope-grid--apps {
  grid-template-columns: repeat(3, 1fr);
}

.scope-grid--packages {
  grid-template-columns: repeat(2, 1fr);
}

@media (max-width: 720px) {
  .scope-grid--apps {
    grid-template-columns: repeat(2, 1fr);
  }
  .scope-grid--packages {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 480px) {
  .scope-grid--apps {
    grid-template-columns: 1fr;
  }
}

/* ── Cards ── */
.scope-card {
  display: flex;
  gap: 12px;
  padding: 14px;
  border-radius: 10px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-default);
  transition:
    border-color 0.25s,
    background 0.25s,
    transform 0.3s var(--ease-out-expo),
    box-shadow 0.3s;
  opacity: 0;
  transform: translateY(10px) scale(0.97);
  cursor: default;
  position: relative;
  overflow: hidden;
}

.scope-card::before {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 0.4s;
  pointer-events: none;
}

.scope-card--brand::before {
  background: radial-gradient(ellipse at 20% 30%, rgba(196, 120, 90, 0.06) 0%, transparent 70%);
}

.scope-card--accent::before {
  background: radial-gradient(ellipse at 20% 30%, rgba(212, 165, 116, 0.05) 0%, transparent 70%);
}

.scope-card:hover::before {
  opacity: 1;
}

.is-visible .scope-card {
  opacity: 1;
  transform: translateY(0) scale(1);
  transition:
    border-color 0.25s,
    background 0.25s,
    transform 0.3s var(--ease-out-expo),
    box-shadow 0.3s,
    opacity 0.5s var(--ease-out-expo);
  transition-delay: calc(0.2s + var(--item-stagger) * 0.06s);
}

.scope-card:hover {
  border-color: var(--color-border-strong);
  transform: translateY(-2px) scale(1.01);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  transition-delay: 0s;
}

.scope-card--highlighted {
  border-color: var(--color-brand) !important;
  box-shadow: 0 0 16px rgba(196, 120, 90, 0.2) !important;
}

.scope-card--accent.scope-card--highlighted {
  border-color: var(--color-accent) !important;
  box-shadow: 0 0 16px rgba(212, 165, 116, 0.2) !important;
}

/* ── Card icon ── */
.scope-card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  flex-shrink: 0;
  transition: box-shadow 0.3s;
}

.scope-card-icon--brand {
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
  color: var(--color-brand);
}

.scope-card-icon--accent {
  background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface));
  color: var(--color-accent);
}

.scope-card:hover .scope-card-icon {
  box-shadow: 0 0 12px rgba(196, 120, 90, 0.15);
}

.scope-card--accent:hover .scope-card-icon {
  box-shadow: 0 0 12px rgba(212, 165, 116, 0.15);
}

/* ── Card body ── */
.scope-card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  position: relative;
}

.scope-card-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.scope-card-name {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  white-space: nowrap;
}

.scope-card-tech {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  white-space: nowrap;
}

.scope-card-desc {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  line-height: 1.45;
}

.scope-card-path {
  font-size: 0.6875rem;
  color: var(--color-text-disabled);
  font-family: var(--font-mono);
}

/* ── Connections strip ── */
.scope-connections {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  padding: 6px 0;
  opacity: 0;
  transition: opacity 0.5s var(--ease-out-expo);
  transition-delay: calc(var(--stagger) * 0.18s + 0.1s);
}

.is-visible .scope-connections {
  opacity: 1;
}

.scope-connections-line {
  width: 2px;
  height: 20px;
  background: var(--color-border-strong);
  border-radius: 1px;
  position: relative;
}

.is-visible .scope-connections-line {
  animation: scope-line-draw 0.6s var(--ease-out-expo) both;
  animation-delay: calc(var(--stagger) * 0.18s + 0.3s);
}

@keyframes scope-line-draw {
  from { transform: scaleY(0); }
  to { transform: scaleY(1); }
}

.is-visible .scope-connections-line::after {
  content: '';
  position: absolute;
  left: -1px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-brand-dim);
  animation: scope-traveling-dot 3s ease-in-out infinite 1.5s;
}

@keyframes scope-traveling-dot {
  0% { top: 0; opacity: 0; }
  10% { opacity: 1; }
  90% { opacity: 1; }
  100% { top: 100%; opacity: 0; }
}

.scope-connections-labels {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  padding: 8px 0;
  max-width: 100%;
}

/* ── Connection tags ── */
.scope-conn-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  font-size: 0.6875rem;
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
  cursor: default;
  transition: border-color 0.25s, background 0.25s, box-shadow 0.25s;
  white-space: nowrap;
}

.scope-conn-tag--dashed {
  border-style: dashed;
}

.scope-conn-tag:hover,
.scope-conn-tag--active {
  border-color: var(--color-brand);
  background: color-mix(in oklab, var(--color-brand) 6%, var(--color-bg-surface));
  box-shadow: 0 0 8px rgba(196, 120, 90, 0.1);
}

.scope-conn-from,
.scope-conn-to {
  font-weight: 600;
  color: var(--color-text-primary);
}

.scope-conn-arrow {
  color: var(--color-text-disabled);
  flex-shrink: 0;
}

.scope-conn-label {
  color: var(--color-text-tertiary);
  margin-left: 2px;
}

/* ── Shared note ── */
.scope-shared-note {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
  padding: 12px 16px;
  border-radius: 10px;
  border: 1px dashed var(--color-border-default);
  background: var(--color-bg-soft);
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  opacity: 0;
  transform: translateY(12px);
  transition: opacity 0.6s var(--ease-out-expo), transform 0.6s var(--ease-out-expo), border-color 0.25s;
  transition-delay: calc(var(--stagger) * 0.18s);
}

.is-visible .scope-shared-note {
  opacity: 1;
  transform: translateY(0);
}

.scope-shared-note:hover {
  border-color: color-mix(in oklab, var(--color-accent) 40%, var(--color-border-default));
}

.scope-shared-note svg {
  color: var(--color-accent);
  flex-shrink: 0;
}

.scope-shared-note code {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--color-accent);
  background: color-mix(in oklab, var(--color-accent) 10%, var(--color-bg-surface));
  padding: 1px 5px;
  border-radius: 4px;
}

/* ── Ambient animations ── */
.is-visible .scope-card {
  animation: scope-card-shimmer 4s ease-in-out infinite;
  animation-delay: calc(var(--item-stagger) * 0.3s + 1.5s);
}

@keyframes scope-card-shimmer {
  0%, 100% { border-color: var(--color-border-default); }
  50% { border-color: color-mix(in oklab, var(--color-brand) 15%, var(--color-border-default)); }
}

.is-visible .scope-card--accent {
  animation-name: scope-card-shimmer-accent;
}

@keyframes scope-card-shimmer-accent {
  0%, 100% { border-color: var(--color-border-default); }
  50% { border-color: color-mix(in oklab, var(--color-accent) 15%, var(--color-border-default)); }
}

.is-visible .scope-card-icon {
  animation: scope-icon-pulse 3s ease-in-out infinite;
  animation-delay: calc(var(--item-stagger) * 0.2s + 2s);
}

@keyframes scope-icon-pulse {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 8px rgba(196, 120, 90, 0.12); }
}

.is-visible .scope-card--accent .scope-card-icon {
  animation-name: scope-icon-pulse-accent;
}

@keyframes scope-icon-pulse-accent {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 8px rgba(212, 165, 116, 0.12); }
}
</style>
