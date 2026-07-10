<script setup lang="ts">
import { ref, onMounted } from 'vue'

const visible = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

const dimensions = [
  { aspect: 'Volume', marketing: 'Thousands to millions per send', private: 'One at a time' },
  { aspect: 'Infrastructure', marketing: 'Dedicated ESPs (SES, SendGrid, Mailgun) or custom MTAs', private: 'Shared mail servers (Gmail, iCloud, Exchange)' },
  { aspect: 'Authentication', marketing: 'Custom domain with SPF, DKIM, DMARC required', private: 'Handled automatically by your email provider' },
  { aspect: 'IP Reputation', marketing: 'Dedicated or pooled IPs, warm-up period required', private: 'Provider\'s shared IP pool (already warmed)' },
  { aspect: 'Compliance', marketing: 'CAN-SPAM, GDPR, List-Unsubscribe header mandatory', private: 'No legal sending requirements' },
  { aspect: 'Throttling', marketing: 'Rate-limited per ISP, adaptive domain throttling', private: 'Provider limits (e.g. ~500/day on Gmail free tier)' },
  { aspect: 'Feedback', marketing: 'Bounce processing, FBL complaints, open/click tracking', private: 'Read receipts (optional, rarely used)' },
  { aspect: 'Content', marketing: 'Rich HTML templates, tracking pixels, UTM links', private: 'Plain text or basic rich text' },
]
</script>

<template>
  <div class="ec" :class="{ 'is-visible': visible }">
    <!-- Column headers -->
    <div class="ec-headers">
      <div class="ec-aspect-spacer" />
      <div class="ec-col-header ec-col-header--marketing">
        <div class="ec-col-icon ec-col-icon--brand">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" /></svg>
        </div>
        <span>Marketing Email</span>
      </div>
      <div class="ec-col-header ec-col-header--private">
        <div class="ec-col-icon ec-col-icon--info">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
        </div>
        <span>Private Email</span>
      </div>
    </div>

    <!-- Comparison rows -->
    <div
      v-for="(dim, i) in dimensions"
      :key="dim.aspect"
      class="ec-row"
      :style="{ '--i': i }"
    >
      <div class="ec-aspect">{{ dim.aspect }}</div>
      <div class="ec-cell ec-cell--marketing">
        <span class="ec-mobile-label">Marketing</span>
        {{ dim.marketing }}
      </div>
      <div class="ec-cell ec-cell--private">
        <span class="ec-mobile-label">Private</span>
        {{ dim.private }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.ec {
  margin: 2rem 0;
}

/* Column headers */
.ec-headers {
  display: grid;
  grid-template-columns: 100px 1fr 1fr;
  gap: 8px;
  margin-bottom: 8px;
}

.ec-aspect-spacer {
  /* empty spacer to align with the aspect column */
}

.ec-col-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  font-weight: var(--font-weight-semibold);
  font-size: 0.8125rem;
  color: var(--color-text-primary);
}

.ec-col-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  flex-shrink: 0;
}

.ec-col-icon--brand {
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
  color: var(--color-brand);
}

.ec-col-icon--info {
  background: color-mix(in oklab, var(--color-info) 12%, var(--color-bg-surface));
  color: var(--color-info);
}

/* Comparison rows */
.ec-row {
  display: grid;
  grid-template-columns: 100px 1fr 1fr;
  gap: 8px;
  margin-bottom: 6px;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(0.1s + var(--i) * 0.07s);
}

.is-visible .ec-row {
  opacity: 1;
  transform: translateY(0);
}

.ec-row:last-child {
  margin-bottom: 0;
}

.ec-aspect {
  display: flex;
  align-items: center;
  font-size: 0.6875rem;
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  padding: 8px 0;
}

.ec-cell {
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  border: 1px solid transparent;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
  transition: border-color var(--motion-moderate), background var(--motion-moderate);
}

.ec-cell:hover {
  border-color: var(--color-border-default);
  background: var(--color-bg-surface-hover);
}

.ec-mobile-label {
  display: none;
}

/* Responsive: stack on mobile */
@media (max-width: 680px) {
  .ec-headers {
    display: none;
  }

  .ec-row {
    grid-template-columns: 1fr;
    gap: 4px;
    padding: 10px 0;
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .ec-row:last-child {
    border-bottom: none;
  }

  .ec-aspect {
    font-size: 0.75rem;
    padding: 0 0 2px 0;
    color: var(--color-text-primary);
  }

  .ec-mobile-label {
    display: inline;
    font-weight: var(--font-weight-semibold);
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-tertiary);
    margin-right: 6px;
    font-family: var(--font-mono);
  }

  .ec-cell--marketing {
    border-left: 2px solid var(--color-brand-dim);
  }

  .ec-cell--private {
    border-left: 2px solid var(--color-info);
  }
}
</style>
