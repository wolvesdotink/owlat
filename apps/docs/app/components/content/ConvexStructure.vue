<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

interface TreeNode {
  name: string
  detail?: string
  icon: string
  color?: 'brand' | 'accent' | 'info' | 'warning' | 'success'
  children?: TreeNode[]
}

const tree: TreeNode[] = [
  {
    name: '_generated/',
    detail: 'Auto-generated (never edit)',
    icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
    color: 'warning',
    children: [
      { name: 'api.d.ts', detail: 'API type definitions', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
      { name: 'dataModel.d.ts', detail: 'Schema types', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
    ],
  },
  {
    name: 'lib/',
    detail: 'Shared utilities',
    icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    color: 'accent',
    children: [
      { name: 'authedFunctions.ts', detail: 'Secure-by-default builders', icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z', color: 'success' },
      { name: 'sessionOrganization.ts', detail: 'Session, roles & permissions', icon: 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z' },
      {
        name: 'sendProviders/',
        detail: 'Provider-agnostic send pipeline',
        icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
        color: 'info',
        children: [
          { name: 'ses/', detail: 'SES sending', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
          { name: 'resend/', detail: 'Resend provider', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
          { name: 'mta/', detail: 'Self-hosted MTA', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
          { name: 'routing.ts', detail: 'Provider routing & dispatch', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
        ],
      },
      {
        name: 'emailProviders/',
        detail: 'Domain identity & verification',
        icon: 'M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9',
        color: 'info',
        children: [
          { name: 'sesIdentity.ts', detail: 'SES domain identity', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
          { name: 'mtaIdentity.ts', detail: 'MTA domain identity', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
          { name: 'domainVerification.ts', detail: 'SPF/DKIM/DMARC checks', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
        ],
      },
    ],
  },
  { name: 'schema/', detail: 'Per-domain table modules', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4', color: 'brand' },
  { name: 'schema.ts', detail: 'Merges domain tables', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4', color: 'brand' },
  { name: 'auth/', detail: 'BetterAuth config, API keys & onboarding', icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z', color: 'brand' },
  { name: 'http.ts', detail: 'HTTP route handlers', icon: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z', color: 'brand' },
  { name: 'crons.ts', detail: 'Scheduled jobs', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z', color: 'warning' },
  { name: '<domain>/', detail: 'API functions by domain', icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2', color: 'accent' },
]

</script>

<template>
  <div class="convex-tree" :class="{ 'is-visible': visible }">
    <div class="ct-header">
      <div class="ct-badge">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
      </div>
      <code class="ct-path">apps/api/convex/</code>
    </div>

    <div class="ct-nodes">
      <template v-for="(node, ni) in tree" :key="node.name">
        <div
          class="ct-node"
          :class="[`ct-node--${node.color || 'brand'}`, { 'ct-node--dir': node.children }]"
          :style="{ '--i': ni }"
        >
          <div class="ct-node-main">
            <svg class="ct-node-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="node.icon" /></svg>
            <code class="ct-node-name">{{ node.name }}</code>
            <span v-if="node.detail" class="ct-node-detail">{{ node.detail }}</span>
          </div>

          <!-- Children (1 level deep) -->
          <template v-if="node.children">
            <template v-for="(child, ci) in node.children" :key="child.name">
              <div
                class="ct-child"
                :class="[`ct-node--${child.color || node.color || 'brand'}`, { 'ct-child--dir': child.children }]"
                :style="{ '--i': ni + ci + 1 }"
              >
                <div class="ct-child-main">
                  <svg class="ct-node-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="child.icon" /></svg>
                  <code class="ct-node-name">{{ child.name }}</code>
                  <span v-if="child.detail" class="ct-node-detail">{{ child.detail }}</span>
                </div>

                <!-- Grandchildren -->
                <template v-if="child.children">
                  <div
                    v-for="(gc, gi) in child.children"
                    :key="gc.name"
                    class="ct-grandchild"
                    :style="{ '--i': ni + ci + gi + 2 }"
                  >
                    <svg class="ct-node-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="gc.icon" /></svg>
                    <code class="ct-node-name">{{ gc.name }}</code>
                    <span v-if="gc.detail" class="ct-node-detail">{{ gc.detail }}</span>
                  </div>
                </template>
              </div>
            </template>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.convex-tree {
  margin: 2rem 0;
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
  padding: 16px 18px;
  background: var(--color-bg-elevated);
  opacity: 0;
  transform: translateY(14px);
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring), border-color var(--motion-moderate);
}

.convex-tree.is-visible {
  opacity: 1;
  transform: translateY(0);
}

.convex-tree:hover {
  border-color: var(--color-border-strong);
}

.ct-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.ct-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface));
  color: var(--color-accent);
}

.ct-path {
  font-size: 0.875rem;
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--color-text-primary);
}

/* Nodes */
.ct-nodes {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ct-node {
  opacity: 0;
  transform: translateX(-8px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
}

.is-visible .ct-node {
  opacity: 1;
  transform: translateX(0);
  transition-delay: calc(0.1s + var(--i) * 0.04s);
}

.ct-node-main,
.ct-child-main {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  transition: background var(--motion-moderate);
}

.ct-node-main:hover,
.ct-child-main:hover {
  background: var(--color-bg-surface);
}

.ct-node-icon {
  flex-shrink: 0;
  transition: color var(--motion-moderate);
}

.ct-node--brand .ct-node-icon { color: var(--color-brand); }
.ct-node--accent .ct-node-icon { color: var(--color-accent); }
.ct-node--info .ct-node-icon { color: var(--color-info); }
.ct-node--warning .ct-node-icon { color: var(--color-warning); }
.ct-node--success .ct-node-icon { color: var(--color-success); }

.ct-node-name {
  font-size: 0.8125rem;
  font-family: var(--font-mono);
  font-weight: 500;
  color: var(--color-text-primary);
}

.ct-node--dir > .ct-node-main > .ct-node-name,
.ct-child--dir > .ct-child-main > .ct-node-name {
  font-weight: 600;
}

.ct-node-detail {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  margin-left: auto;
  white-space: nowrap;
}

@media (max-width: 580px) {
  .ct-node-detail {
    display: none;
  }
}

/* Children */
.ct-child {
  padding-left: 22px;
  border-left: 1px solid var(--color-border-subtle);
  margin-left: 16px;
  opacity: 0;
  transform: translateX(-6px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
}

.is-visible .ct-child {
  opacity: 1;
  transform: translateX(0);
  transition-delay: calc(0.1s + var(--i) * 0.04s);
}

/* Grandchildren */
.ct-grandchild {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  padding-left: 22px;
  border-left: 1px solid var(--color-border-subtle);
  margin-left: 16px;
  border-radius: 0 6px 6px 0;
  transition: background var(--motion-moderate);
  opacity: 0;
  transform: translateX(-6px);
}

.is-visible .ct-grandchild {
  opacity: 1;
  transform: translateX(0);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring), background var(--motion-moderate);
  transition-delay: calc(0.1s + var(--i) * 0.03s);
}

.ct-grandchild:hover {
  background: var(--color-bg-surface);
  transition-delay: 0s;
}

.ct-grandchild .ct-node-icon {
  color: var(--color-text-disabled);
}

.ct-grandchild .ct-node-name {
  font-size: 0.75rem;
  font-weight: 400;
}

.ct-grandchild .ct-node-detail {
  font-size: 0.625rem;
}

/* Ambient */
.convex-tree.is-visible {
}

</style>
