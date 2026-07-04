<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const stages = [
  {
    label: 'Mail User Agent (MUA)',
    detail: 'Gmail, Outlook, Thunderbird, or your app',
    description: 'The sender composes the message and hits send.',
    protocol: 'User action',
    icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
    type: 'sender',
  },
  {
    label: 'Mail Submission Agent (MSA)',
    detail: 'Port 587 with STARTTLS',
    description: 'Authenticates the sender and accepts the message for delivery.',
    protocol: 'SMTP AUTH',
    icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
    type: 'infra',
  },
  {
    label: 'Sending MTA',
    detail: 'Outbound mail server',
    description: 'Signs the message with DKIM, checks SPF, and routes it to the destination.',
    protocol: 'SMTP',
    icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01',
    type: 'infra',
  },
  {
    label: 'DNS Lookup',
    detail: 'MX record resolution',
    description: 'Queries DNS to find the recipient domain\'s mail server address.',
    protocol: 'DNS',
    icon: 'M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9',
    type: 'dns',
  },
  {
    label: 'Receiving MTA',
    detail: 'Recipient\'s inbound server',
    description: 'Checks SPF, verifies DKIM signature, and evaluates DMARC policy.',
    protocol: 'SMTP',
    icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
    type: 'gate',
  },
  {
    label: 'Mail Delivery Agent (MDA)',
    detail: 'Spam filter, folder routing, storage',
    description: 'Applies spam filters, sorts into the correct mailbox, and stores the message.',
    protocol: 'LMTP',
    icon: 'M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4',
    type: 'infra',
  },
  {
    label: 'Recipient\'s MUA',
    detail: 'IMAP / POP3 / Webmail',
    description: 'The recipient opens their mail client and reads the message.',
    protocol: 'IMAP',
    icon: 'M3 19v-8.93a2 2 0 01.89-1.664l7-4.666a2 2 0 012.22 0l7 4.666A2 2 0 0121 10.07V19M3 19a2 2 0 002 2h14a2 2 0 002-2M3 19l6.75-4.5M21 19l-6.75-4.5M3 10l6.75 4.5M21 10l-6.75 4.5m0 0l-1.14.76a2 2 0 01-2.22 0l-1.14-.76',
    type: 'recipient',
  },
]

function typeColor(type: string) {
  switch (type) {
    case 'sender': return 'brand'
    case 'infra': return 'info'
    case 'dns': return 'accent'
    case 'gate': return 'warning'
    case 'recipient': return 'success'
    default: return 'brand'
  }
}
</script>

<template>
  <div class="ej" :class="{ 'is-visible': visible }">
    <div class="ej-track">
      <!-- Vertical connecting line -->
      <div class="ej-line" />

      <div
        v-for="(stage, i) in stages"
        :key="stage.label"
        class="ej-stage"
        :class="`ej-stage--${stage.type}`"
        :style="{ '--si': i }"
      >
        <!-- Node circle -->
        <div class="ej-node">
          <div class="ej-node-ring" />
          <svg
            class="ej-node-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path :d="stage.icon" />
          </svg>
        </div>

        <!-- Content card -->
        <div class="ej-card">
          <div class="ej-card-top">
            <span class="ej-label">{{ stage.label }}</span>
            <span class="ej-protocol" :class="`ej-protocol--${typeColor(stage.type)}`">{{ stage.protocol }}</span>
          </div>
          <span class="ej-detail">{{ stage.detail }}</span>
          <span class="ej-desc">{{ stage.description }}</span>
        </div>

        <!-- Connector chevron between stages -->
        <div v-if="i < stages.length - 1" class="ej-chevron">
          <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
            <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ej {
  margin: 2rem 0;
}

.ej-track {
  position: relative;
  padding-left: 32px;
}

/* Vertical connecting line */
.ej-line {
  position: absolute;
  left: 13px;
  top: 14px;
  bottom: 14px;
  width: 2px;
  background: linear-gradient(
    to bottom,
    var(--color-brand-dim),
    var(--color-info),
    var(--color-accent),
    var(--color-warning),
    var(--color-success)
  );
  border-radius: 1px;
  transform-origin: top;
  transform: scaleY(0);
  transition: transform 1s var(--ease-spring) var(--motion-moderate);
}

.is-visible .ej-line {
  transform: scaleY(1);
}

/* Traveling dot */
.is-visible .ej-line::after {
  content: '';
  position: absolute;
  left: -1px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-brand);
  animation: ej-dot 4s ease-in-out infinite 1.5s;
}

@keyframes ej-dot {
  0% { top: 0; opacity: 0; }
  8% { opacity: 1; }
  92% { opacity: 1; }
  100% { top: 100%; opacity: 0; }
}

/* Stage */
.ej-stage {
  position: relative;
  margin-bottom: 6px;
  opacity: 0;
  transform: translateX(-10px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(0.2s + var(--si) * 0.12s);
}

.is-visible .ej-stage {
  opacity: 1;
  transform: translateX(0);
}

.ej-stage:last-child {
  margin-bottom: 0;
}

/* Node circle */
.ej-node {
  position: absolute;
  left: -32px;
  top: 10px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1;
}

.ej-node-ring {
  position: absolute;
  inset: 2px;
  border-radius: 50%;
  border: 2px solid var(--color-brand-dim);
  background: var(--color-bg-elevated);
  transition: border-color var(--motion-moderate), box-shadow var(--motion-moderate);
}

.ej-stage:hover .ej-node-ring {
  box-shadow: 0 0 12px rgba(196, 120, 90, 0.25);
}

/* Node ring color by type */
.ej-stage--sender .ej-node-ring { border-color: var(--color-brand-dim); }
.ej-stage--infra .ej-node-ring { border-color: var(--color-info); }
.ej-stage--dns .ej-node-ring { border-color: var(--color-accent); }
.ej-stage--gate .ej-node-ring { border-color: var(--color-warning); }
.ej-stage--recipient .ej-node-ring { border-color: var(--color-success); }

.ej-stage--sender:hover .ej-node-ring { border-color: var(--color-brand); box-shadow: 0 0 12px rgba(196, 120, 90, 0.3); }
.ej-stage--infra:hover .ej-node-ring { border-color: var(--color-info); box-shadow: 0 0 12px rgba(107, 143, 168, 0.3); }
.ej-stage--dns:hover .ej-node-ring { border-color: var(--color-accent); box-shadow: 0 0 12px rgba(212, 165, 116, 0.3); }
.ej-stage--gate:hover .ej-node-ring { border-color: var(--color-warning); box-shadow: 0 0 12px rgba(201, 165, 90, 0.3); }
.ej-stage--recipient:hover .ej-node-ring { border-color: var(--color-success); box-shadow: 0 0 12px rgba(122, 155, 110, 0.3); }

.ej-node-icon {
  position: relative;
  z-index: 1;
  color: var(--color-brand-muted);
  transition: color var(--motion-moderate);
}

.ej-stage--sender .ej-node-icon { color: var(--color-brand-muted); }
.ej-stage--infra .ej-node-icon { color: var(--color-info); }
.ej-stage--dns .ej-node-icon { color: var(--color-accent); }
.ej-stage--gate .ej-node-icon { color: var(--color-warning); }
.ej-stage--recipient .ej-node-icon { color: var(--color-success); }

/* Content card */
.ej-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  border: 1px solid transparent;
  transition: border-color var(--motion-moderate), background var(--motion-moderate);
}

.ej-stage:hover .ej-card {
  border-color: var(--color-border-default);
  background: var(--color-bg-surface-hover);
}

.ej-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ej-label {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  line-height: 1.4;
}

.ej-protocol {
  padding: 1px 8px;
  border-radius: 9999px;
  font-size: 0.625rem;
  font-family: var(--font-mono);
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.ej-protocol--brand {
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
  color: var(--color-brand);
}

.ej-protocol--info {
  background: color-mix(in oklab, var(--color-info) 12%, var(--color-bg-surface));
  color: var(--color-info);
}

.ej-protocol--accent {
  background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface));
  color: var(--color-accent);
}

.ej-protocol--warning {
  background: color-mix(in oklab, var(--color-warning) 12%, var(--color-bg-surface));
  color: var(--color-warning);
}

.ej-protocol--success {
  background: color-mix(in oklab, var(--color-success) 12%, var(--color-bg-surface));
  color: var(--color-success);
}

.ej-detail {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

.ej-desc {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

/* Chevron between stages */
.ej-chevron {
  display: flex;
  justify-content: center;
  padding: 2px 0;
  color: var(--color-text-disabled);
}

/* Ambient node pulse */
.is-visible .ej-node-ring {
  animation: ej-pulse 3s ease-in-out infinite;
  animation-delay: calc(var(--si) * 0.4s + 1s);
}

@keyframes ej-pulse {
  0%, 100% { box-shadow: 0 0 0 0 transparent; }
  50% { box-shadow: 0 0 8px 1px rgba(196, 120, 90, 0.12); }
}
</style>
