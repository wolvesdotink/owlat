<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const files = [
  { name: 'contacts/', purpose: 'CRM contacts & identities', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z', color: 'brand' },
  { name: 'topics/', purpose: 'Topics & DOI flows', icon: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z', color: 'brand' },
  { name: 'campaigns/', purpose: 'Campaigns & scheduling', icon: 'M12 19l9 2-9-18-9 18 9-2zm0 0v-8', color: 'accent' },
  { name: 'emailTemplates/', purpose: 'Template CRUD', icon: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm0 8a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zm12 0a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z', color: 'accent' },
  { name: 'emailBlocks/', purpose: 'Saved blocks', icon: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6z', color: 'accent' },
  { name: 'segments.ts', purpose: 'Segment filtering', icon: 'M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z', color: 'brand' },
  { name: 'automations/', purpose: 'Trigger-based workflows', icon: 'M13 10V3L4 14h7v7l9-11h-7z', color: 'warning' },
  { name: 'transactional/', purpose: 'Transactional send API', icon: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z', color: 'info' },
  { name: 'domains/', purpose: 'Domains, DNS & warming', icon: 'M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9', color: 'info' },
  { name: 'delivery/', purpose: 'Send pipeline & lifecycle', icon: 'M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z', color: 'info' },
  { name: 'webhooks/', purpose: 'Outbound webhooks & logs', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z', color: 'success' },
  { name: 'inbox/', purpose: 'Shared inbox & threading', icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z', color: 'brand' },
  { name: 'mail/', purpose: 'SMTP/IMAP mailboxes & drafts', icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z', color: 'brand' },
  { name: 'emails.ts', purpose: 'Rendering & sending', icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z', color: 'accent' },
]
</script>

<template>
  <div class="api-files" :class="{ 'is-visible': visible }">
    <div class="af-grid">
      <div
        v-for="(file, i) in files"
        :key="file.name"
        class="af-file"
        :class="`af-file--${file.color}`"
        :style="{ '--i': i }"
      >
        <div class="af-file-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="file.icon" /></svg>
        </div>
        <div class="af-file-text">
          <code class="af-file-name">{{ file.name }}</code>
          <span class="af-file-purpose">{{ file.purpose }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.api-files {
  margin: 2rem 0;
}

.af-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

@media (max-width: 720px) {
  .af-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 480px) {
  .af-grid {
    grid-template-columns: 1fr;
  }
}

.af-file {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-bg-elevated);
  border: 1px solid transparent;
  transition: border-color var(--motion-moderate), background var(--motion-moderate), transform var(--motion-moderate) var(--ease-spring);
  opacity: 0;
  transform: translateY(8px);
}

.is-visible .af-file {
  opacity: 1;
  transform: translateY(0);
  transition-delay: calc(0.05s + var(--i) * 0.04s);
}

.af-file:hover {
  border-color: var(--color-border-default);
  background: var(--color-bg-surface-hover);
  transform: translateY(-1px);
  transition-delay: 0s;
}

.af-file-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: var(--color-bg-surface);
  flex-shrink: 0;
  transition: box-shadow var(--motion-moderate);
}

.af-file--brand .af-file-icon { color: var(--color-brand); }
.af-file--accent .af-file-icon { color: var(--color-accent); }
.af-file--info .af-file-icon { color: var(--color-info); }
.af-file--warning .af-file-icon { color: var(--color-warning); }
.af-file--success .af-file-icon { color: var(--color-success); }

.af-file:hover .af-file-icon {
  box-shadow: 0 0 8px rgba(196, 120, 90, 0.12);
}

.af-file-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.af-file-name {
  font-size: 0.8125rem;
  font-weight: var(--font-weight-semibold);
  font-family: var(--font-mono);
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.af-file-purpose {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
}
</style>
