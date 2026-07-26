<script setup lang="ts">
/**
 * Delivery-page card for Google Postmaster Tools v2.
 *
 * Two states, both calm. Connected: Google's Compliance Status verdicts and
 * measured rates, rendered as actions ("Gmail rates this domain badly — send
 * only to engaged contacts for a while") rather than raw API fields. Not
 * connected: one sentence explaining what connecting would buy, and nothing
 * else. Postmaster is an additive signal — its absence lowers measurement
 * confidence and is never an error, a warning or a setup nag.
 *
 * Prop-driven so every state is unit-tested directly; the Delivery page owns
 * the (member-safe) query.
 */
import { formatDate } from '~/utils/formatters';

interface PostmasterCard {
	id: string;
	severity: 'critical' | 'warning' | 'info';
	title: string;
	detail: string;
	remedy: string;
	check: string;
}

interface PostmasterDomainStatus {
	domain: string;
	periodStart: number | null;
	compliancePeriodStart: number | null;
	cards: PostmasterCard[];
}

interface PostmasterStatus {
	connected: boolean;
	domains: PostmasterDomainStatus[];
}

const props = defineProps<{
	status: PostmasterStatus | null | undefined;
	isLoading: boolean;
}>();

const POSTMASTER_DOCS =
	'https://docs.owlat.app/developer/external-reputation-feedback#google-postmaster-tools';

const SEVERITY_TONE = {
	critical: 'border-error/40 bg-error/5',
	warning: 'border-warning/40 bg-warning/5',
	info: 'border-border-subtle',
} as const;

const SEVERITY_ICON = {
	critical: 'lucide:alert-triangle',
	warning: 'lucide:alert-circle',
	info: 'lucide:info',
} as const;

const reportedDomains = computed(() =>
	(props.status?.domains ?? []).filter(
		(domain) => domain.periodStart !== null || domain.compliancePeriodStart !== null
	)
);

const failingDomains = computed(() =>
	reportedDomains.value.filter((domain) => domain.cards.length > 0)
);

function observedAt(domain: PostmasterDomainStatus): number | null {
	return domain.compliancePeriodStart ?? domain.periodStart;
}
</script>

<template>
	<UiCard>
		<div class="space-y-5">
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:mail-check" size="lg" variant="brand" rounded="xl" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Gmail compliance</h2>
					<p class="text-sm text-text-secondary">
						What Google Postmaster Tools reports about your sending domains
					</p>
				</div>
			</div>

			<div
				v-if="isLoading"
				data-testid="postmaster-loading"
				class="h-24 animate-pulse rounded-lg bg-surface-subtle"
			/>

			<!-- Not connected is a supported configuration, not an incomplete setup. -->
			<div
				v-else-if="!status?.connected"
				data-testid="postmaster-not-connected"
				class="rounded-lg border border-border-subtle p-4"
			>
				<p class="text-sm text-text-primary">Not connected</p>
				<p class="mt-1 text-sm text-text-secondary">
					Sending works exactly the same without this. Connecting a free Google Postmaster account
					adds Gmail's own view of your spam rate and authentication, which raises measurement
					confidence.
				</p>
				<a
					:href="POSTMASTER_DOCS"
					target="_blank"
					rel="noopener"
					class="mt-2 inline-block text-sm text-brand hover:underline"
				>
					How to connect
				</a>
			</div>

			<div
				v-else-if="failingDomains.length === 0"
				data-testid="postmaster-all-clear"
				class="rounded-lg border border-success/40 bg-success/5 p-4"
			>
				<p class="text-sm text-text-primary">
					Google reports no failing checks for
					{{ reportedDomains.length === 1 ? 'your sending domain' : 'your sending domains' }}.
				</p>
			</div>

			<div v-else class="space-y-4">
				<section
					v-for="domain in failingDomains"
					:key="domain.domain"
					data-testid="postmaster-domain"
					class="space-y-2"
				>
					<div class="flex items-baseline justify-between gap-3">
						<p class="text-sm font-medium text-text-primary">{{ domain.domain }}</p>
						<p v-if="observedAt(domain) !== null" class="text-xs text-text-tertiary">
							Google data for {{ formatDate(observedAt(domain), 'short') }}
						</p>
					</div>
					<article
						v-for="card in domain.cards"
						:key="card.id"
						data-testid="postmaster-card"
						:data-check="card.check"
						class="rounded-lg border p-4"
						:class="SEVERITY_TONE[card.severity]"
					>
						<div class="flex items-start gap-2">
							<Icon
								:name="SEVERITY_ICON[card.severity]"
								class="w-4 h-4 mt-0.5 shrink-0 text-text-secondary"
							/>
							<div class="min-w-0 space-y-1">
								<p class="text-sm font-medium text-text-primary">{{ card.title }}</p>
								<p class="text-sm text-text-secondary">{{ card.detail }}</p>
								<p data-testid="postmaster-card-remedy" class="text-sm text-text-secondary">
									{{ card.remedy }}
								</p>
							</div>
						</div>
					</article>
				</section>
			</div>
		</div>
	</UiCard>
</template>
