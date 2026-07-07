<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Delivery health — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { isLoading: teamLoading } = useOrganizationContext();

// Fetch sending overview (tier, limits, reputation, progression)
const {
	data: sendingOverview,
	isLoading: overviewLoading,
	error: overviewError,
} = useOrganizationQuery(api.analytics.reputationQueries.getSendingOverview);

// Fetch per-domain reputations
const { data: domainReputations, isLoading: domainsLoading } = useOrganizationQuery(
	api.analytics.reputationQueries.getDomainReputations
);

const isLoading = computed(() => teamLoading.value || overviewLoading.value);
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6 flex items-start justify-between gap-4">
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:shield-check" size="lg" variant="brand" rounded="xl" />
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Delivery health</h1>
					<p class="mt-1 text-text-secondary">
						Monitor your domain reputation, sending limits, and account health
					</p>
				</div>
			</div>
			<NuxtLink
				to="/dashboard/delivery/setup"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-brand transition-colors shrink-0 mt-1"
			>
				<Icon name="lucide:settings-2" class="w-4 h-4" />
				Delivery setup
			</NuxtLink>
		</div>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<Icon name="lucide:loader-2" class="w-8 h-8 animate-spin text-text-tertiary" />
		</div>

		<UiErrorAlert
			v-else-if="overviewError"
			title="Couldn't load sending reputation"
			message="We hit an error loading your reputation data. Reload to try again."
			class="my-8"
		/>

		<div v-else-if="sendingOverview" class="space-y-6">
			<!-- Section 1: Sending Limits -->
			<ReputationSendingLimitsCard
				:warming="sendingOverview.warming"
				:volume="sendingOverview.volume"
				:abuse-status="sendingOverview.abuseStatus"
			/>

			<!-- Section 2: Org Reputation -->
			<ReputationOrgReputationCard :reputation="sendingOverview.reputation" />

			<!-- Section 3: Domain Reputation -->
			<ReputationDomainReputationTable v-if="!domainsLoading" :domains="domainReputations ?? []" />

			<!-- Section 4: Tips -->
			<UiCard>
				<div class="space-y-4">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:lightbulb" size="lg" variant="brand" rounded="xl" />
						<div>
							<h2 class="text-lg font-semibold text-text-primary">How to Improve</h2>
							<p class="text-sm text-text-secondary">
								Best practices for maintaining a healthy sending reputation
							</p>
						</div>
					</div>

					<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<div class="p-4 rounded-lg bg-bg-surface">
							<div class="flex items-center gap-2 mb-2">
								<Icon name="lucide:arrow-down-right" class="w-4 h-4 text-brand" />
								<p class="text-sm font-medium text-text-primary">Keep bounce rate below 2%</p>
							</div>
							<p class="text-xs text-text-tertiary">
								Regularly clean your contact list by removing invalid or inactive email addresses.
								Use double opt-in to ensure valid emails.
							</p>
						</div>
						<div class="p-4 rounded-lg bg-bg-surface">
							<div class="flex items-center gap-2 mb-2">
								<Icon name="lucide:flag" class="w-4 h-4 text-brand" />
								<p class="text-sm font-medium text-text-primary">Keep complaint rate below 0.1%</p>
							</div>
							<p class="text-xs text-text-tertiary">
								Only email opted-in contacts and make unsubscribing easy. Gmail and Yahoo reject
								senders above 0.3%.
							</p>
						</div>
						<div class="p-4 rounded-lg bg-bg-surface">
							<div class="flex items-center gap-2 mb-2">
								<Icon name="lucide:trending-up" class="w-4 h-4 text-brand" />
								<p class="text-sm font-medium text-text-primary">
									Your sending capacity increases daily based on deliverability signals
								</p>
							</div>
							<p class="text-xs text-text-tertiary">
								New IPs typically take ~30 days to fully warm. The MTA automatically adjusts daily
								capacity based on bounce and deferral rates.
							</p>
						</div>
						<div class="p-4 rounded-lg bg-bg-surface">
							<div class="flex items-center gap-2 mb-2">
								<Icon name="lucide:shield-check" class="w-4 h-4 text-brand" />
								<p class="text-sm font-medium text-text-primary">Verify your sending domains</p>
							</div>
							<p class="text-xs text-text-tertiary">
								Configure SPF, DKIM, and DMARC records for all your sending domains to improve
								deliverability and protect against spoofing.
							</p>
						</div>
					</div>
				</div>
			</UiCard>
		</div>

		<!-- No settings found -->
		<UiEmptyState
			v-else
			icon="lucide:shield-check"
			title="No data available"
			description="Sending reputation data will appear once your organization settings are configured."
		/>
	</div>
</template>
