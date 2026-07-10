<script setup lang="ts">
/**
 * The one delivery-readiness panel that leads the Delivery hub.
 *
 * It answers a single question — "can this instance actually send mail, and if
 * not, what's the next thing to do?" — by DERIVING one verdict from the real
 * backend state: the send transport (`getTransportSummary.canSend`, the same
 * gate the send path uses) and every sending domain's verification + SPF/DKIM/
 * DMARC (`getDeliveryDomainTable`). This is where the two halves of go-live meet,
 * so the self-host onboarding banner can point here instead of re-listing
 * "configure a provider" / "verify a domain" as if the wizard never ran.
 *
 * Member-readable: both queries are non-secret (transport kind + booleans, domain
 * names + verification state) — editing still happens on the admin-gated pages
 * each gate links to.
 */
import { api } from '@owlat/api';
import { deriveDeliveryReadiness, type ReadinessGateStatus } from '~/utils/deliveryReadiness';
import { healthChipClass, type HealthTone } from '~/utils/healthTone';

const {
	data: transport,
	isLoading: transportLoading,
	error: transportError,
} = useOrganizationQuery(api.delivery.status.getTransportSummary);

const {
	data: domainRows,
	isLoading: domainsLoading,
	error: domainsError,
} = useOrganizationQuery(api.analytics.reputationQueries.getDeliveryDomainTable);

const isLoading = computed(() => transportLoading.value || domainsLoading.value);
const hasError = computed(() => Boolean(transportError.value || domainsError.value));

const readiness = computed(() => {
	const summary = transport.value;
	if (!summary) return null;
	const rows = domainRows.value ?? [];
	const verified = rows.filter((row) => row.status === 'verified');
	// Report authentication against the domain we'd actually send from: a verified
	// domain first, else the most-active configured one (rows are sorted desc).
	const primary = verified[0] ?? rows[0] ?? null;
	return deriveDeliveryReadiness({
		transportConfigured: summary.canSend,
		hasDomains: rows.length > 0,
		domainVerified: verified.length > 0,
		authComplete: primary ? primary.missing.length === 0 : false,
		authMissing: primary?.missing ?? [],
	});
});

// Per-gate glyph + text colour, drawn from the same tone vocabulary as the rest
// of the delivery surface (never the brand terracotta for state).
const GATE_ICON: Record<ReadinessGateStatus, string> = {
	ready: 'lucide:check-circle-2',
	attention: 'lucide:alert-circle',
	pending: 'lucide:clock',
};
const TONE_TEXT: Record<HealthTone, string> = {
	success: 'text-success',
	warning: 'text-warning',
	error: 'text-error',
	neutral: 'text-text-tertiary',
};
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<!-- Loading: skeleton over spinner-only, matching the native-feel bar. -->
		<div v-if="isLoading" class="p-6 space-y-4" aria-busy="true">
			<div class="flex items-center gap-3">
				<div class="w-10 h-10 rounded-xl bg-bg-surface animate-pulse" />
				<div class="flex-1 space-y-2">
					<div class="h-4 w-40 rounded bg-bg-surface animate-pulse" />
					<div class="h-3 w-64 rounded bg-bg-surface animate-pulse" />
				</div>
			</div>
			<div v-for="n in 3" :key="n" class="h-12 rounded-lg bg-bg-surface animate-pulse" />
		</div>

		<!-- Error -->
		<div v-else-if="hasError" class="p-6 flex items-start gap-3">
			<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning mt-0.5 shrink-0" />
			<p class="text-sm text-text-secondary">
				Couldn't check delivery readiness just now. Reload to try again.
			</p>
		</div>

		<div v-else-if="readiness" class="p-6 space-y-5">
			<!-- Headline verdict -->
			<div class="flex items-start justify-between gap-4">
				<div class="flex items-start gap-3 min-w-0">
					<UiIconBox icon="lucide:rocket" size="md" variant="brand" rounded="lg" />
					<div class="min-w-0">
						<p class="text-xs font-medium uppercase tracking-wide text-text-tertiary">
							Delivery readiness
						</p>
						<div class="flex items-center gap-2.5 mt-0.5">
							<h2 class="text-lg font-semibold text-text-primary">Can this instance send?</h2>
							<span
								class="px-2.5 py-1 rounded-full text-xs font-medium shrink-0"
								:class="healthChipClass[readiness.tone]"
							>
								{{ readiness.headline }}
							</span>
						</div>
						<p class="text-sm text-text-secondary mt-1">{{ readiness.summary }}</p>
					</div>
				</div>
			</div>

			<!-- The one gate list: transport · domain · authentication, one truth. -->
			<ul class="space-y-2">
				<li
					v-for="g in readiness.gates"
					:key="g.key"
					class="flex items-start gap-3 rounded-lg bg-bg-surface px-3 py-3"
				>
					<Icon
						:name="GATE_ICON[g.status]"
						class="w-5 h-5 mt-0.5 shrink-0"
						:class="TONE_TEXT[g.tone]"
					/>
					<div class="flex-1 min-w-0">
						<p class="text-sm font-medium text-text-primary">{{ g.title }}</p>
						<p class="text-sm text-text-secondary mt-0.5">{{ g.detail }}</p>
					</div>
					<NuxtLink
						v-if="g.actionHref && g.actionLabel"
						:to="g.actionHref"
						class="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline shrink-0 mt-0.5 group"
					>
						{{ g.actionLabel }}
						<Icon
							name="lucide:arrow-right"
							class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform duration-(--motion-fast)"
						/>
					</NuxtLink>
				</li>
			</ul>
		</div>
	</UiCard>
</template>
