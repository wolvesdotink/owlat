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
import {
	deriveDeliveryReadiness,
	readinessInputFromSources,
	type ReadinessGateStatus,
	type ReadinessMtaStsSource,
} from '~/utils/deliveryReadiness';
import { healthChipClass, healthTextClass } from '~/utils/healthTone';

const { canManageOrganization } = usePermissions();

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

// MTA-STS publishing is an admin-gated inbound-TLS concern; `getMtaStsGuidance`
// requires `organization:manage`, so subscribe only for admins (conditional
// args). A member sees the same three gates as before — they can't fix an
// inbound-TLS record anyway, and the readiness input treats a `null` source as
// "no warning".
const { data: mtaStsGuidance } = useConvexQuery(api.domains.mtaSts.getMtaStsGuidance, () =>
	canManageOrganization.value ? {} : 'skip'
);

// The domain whose published MTA-STS records we verify: the most-active verified
// sending domain (the one readiness already reports auth against), falling back
// to the most-active configured domain.
const mtaStsDomain = computed<string | null>(() => {
	const rows = domainRows.value ?? [];
	return rows.find((row) => row.status === 'verified')?.domain ?? rows[0]?.domain ?? null;
});

// Live verify of the published policy vs what we serve. Admin-gated + fail-soft
// (never throws); the shared composable runs it once `enforce` is published and
// a domain is available, so deployments not enforcing make no backend call.
const { verification: mtaStsVerification } = useMtaStsVerification(() =>
	canManageOrganization.value && mtaStsGuidance.value?.mode === 'enforce'
		? mtaStsDomain.value
		: null
);

// Only claim "enforce without record" once the mode is known AND we have a
// verdict; before the verify resolves (or for a non-admin) leave it null so the
// gate never flashes an unconfirmed warning.
const mtaStsSource = computed<ReadinessMtaStsSource | null>(() => {
	const mode = mtaStsGuidance.value?.mode;
	if (!mode) return null;
	if (mode !== 'enforce') return { mode, recordVerified: true };
	if (!mtaStsVerification.value) return null;
	return { mode, recordVerified: mtaStsVerification.value.verified };
});

const isLoading = computed(() => transportLoading.value || domainsLoading.value);
const hasError = computed(() => Boolean(transportError.value || domainsError.value));

const readiness = computed(() => {
	const summary = transport.value;
	if (!summary) return null;
	return deriveDeliveryReadiness(
		readinessInputFromSources(summary, domainRows.value ?? [], mtaStsSource.value)
	);
});

// Per-gate glyph; the text colour reuses the shared tone → class map so it can't
// drift from the dot/chip renderings (never the brand terracotta for state).
const GATE_ICON: Record<ReadinessGateStatus, string> = {
	ready: 'lucide:check-circle-2',
	attention: 'lucide:alert-circle',
	pending: 'lucide:clock',
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
						:class="healthTextClass[g.tone]"
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
