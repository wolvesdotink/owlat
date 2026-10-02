<script setup lang="ts">
/**
 * DMARC reports — who sends mail as each sending domain, and how close the
 * domain is to `p=reject`.
 *
 * Built from the aggregate reports receivers mail to Owlat's report address
 * (`domains/dmarcReports.ts`). One domain at a time: the picker lists every
 * domain with a DMARC record, `?domain=` deep-links one (the domain row's
 * "Open reports" link), and the window toggle picks 7, 30 or 90 days.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	DMARC_WINDOW_OPTIONS,
	formatPassRate,
	passRateTone,
	type DmarcWindowDays,
} from '~/utils/dmarcReportView';
import { formatNumber, formatRelativeTime } from '~/utils/formatters';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.admin.delivery.dmarc.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
});

const route = useRoute();
const router = useRouter();

const {
	data: domainsData,
	isLoading: domainsLoading,
	error: domainsError,
	refetch: refetchDomains,
} = useOrganizationQuery(api.domains.domains.listByOrganization);

// Only domains that publish a DMARC record can have reports.
const domains = computed(() =>
	(domainsData.value ?? [])
		.filter((domain) => domain.dnsRecords?.dmarc)
		.sort(
			(a, b) =>
				Number(b.status === 'verified') - Number(a.status === 'verified') ||
				a.domain.localeCompare(b.domain)
		)
);
const domainOptions = computed(() =>
	domains.value.map((domain) => ({ value: domain.domain, label: domain.domain }))
);

const selectedName = computed<string | null>({
	get: () => {
		const wanted = route.query['domain'];
		const match = domains.value.find((domain) => domain.domain === wanted);
		return (match ?? domains.value[0])?.domain ?? null;
	},
	set: (name) => {
		void router.replace({ query: { ...route.query, domain: name ?? undefined } });
	},
});
const selected = computed(
	() => domains.value.find((domain) => domain.domain === selectedName.value) ?? null
);
const selectedId = computed<Id<'domains'> | null>(() => selected.value?._id ?? null);

const windowDays = ref<DmarcWindowDays>(30);
const windowOptions = computed(() =>
	DMARC_WINDOW_OPTIONS.map((days) => ({
		value: String(days),
		label: t('dashboard.admin.delivery.dmarc.window', { days }),
	}))
);

const {
	data: summary,
	isLoading: summaryLoading,
	error: summaryError,
	refetch: refetchSummary,
} = useConvexQuery(
	api.domains.dmarcReports.getDomainSummary,
	() => (selectedId.value ? { domainId: selectedId.value, windowDays: windowDays.value } : 'skip'),
	{ keepPreviousData: true }
);

const tiles = computed(() => {
	const data = summary.value;
	if (!data) return [];
	return [
		{
			key: 'messages',
			label: t('dashboard.admin.delivery.dmarc.tiles.messages'),
			value: formatNumber(data.messageCount, locale.value),
			hint: `${t(
				'dashboard.admin.delivery.dmarc.tiles.messagesHint',
				{ count: data.reportCount },
				data.reportCount
			)} · ${t(
				'dashboard.admin.delivery.dmarc.tiles.reportersHint',
				{ count: data.reporterCount },
				data.reporterCount
			)}`,
			tone: 'default' as const,
		},
		{
			key: 'passRate',
			label: t('dashboard.admin.delivery.dmarc.tiles.passRate'),
			value: formatPassRate(data.alignedRate),
			hint: t('dashboard.admin.delivery.dmarc.tiles.passRateHint'),
			tone: (
				{ success: 'success', warning: 'warning', error: 'error', neutral: 'default' } as const
			)[passRateTone(data.alignedRate)],
		},
		{
			key: 'failing',
			label: t('dashboard.admin.delivery.dmarc.tiles.failing'),
			value: formatNumber(data.messageCount - data.alignedCount, locale.value),
			hint: t('dashboard.admin.delivery.dmarc.tiles.failingHint', {
				count: formatNumber(data.enforcedCount, locale.value),
			}),
			tone: 'default' as const,
		},
	];
});
</script>

<template>
	<div>
		<div class="mb-6 flex items-center gap-3">
			<UiIconBox icon="lucide:file-search" size="lg" variant="brand" rounded="xl" />
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('dashboard.admin.delivery.dmarc.title') }}
				</h1>
				<p class="mt-1 text-text-secondary">{{ t('dashboard.admin.delivery.dmarc.lede') }}</p>
			</div>
		</div>

		<UiQueryBoundary
			:loading="domainsLoading && !domainsData"
			:error="domainsError"
			:empty="domains.length === 0"
			@retry="refetchDomains"
		>
			<template #empty>
				<UiEmptyState
					icon="lucide:globe"
					:eyebrow="t('dashboard.admin.delivery.dmarc.title')"
					:title="t('dashboard.admin.delivery.dmarc.noDomains.title')"
					:description="t('dashboard.admin.delivery.dmarc.noDomains.description')"
				>
					<template #action>
						<UiButton to="/dashboard/admin/delivery/domains">
							{{ t('dashboard.admin.delivery.dmarc.noDomains.action') }}
						</UiButton>
					</template>
				</UiEmptyState>
			</template>

			<div class="space-y-6">
				<!-- Domain + window -->
				<div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
					<div class="w-full sm:max-w-xs">
						<UiSelect
							v-model="selectedName"
							:label="t('dashboard.admin.delivery.dmarc.domainLabel')"
							:options="domainOptions"
						/>
					</div>
					<UiSegmentedControl
						:model-value="String(windowDays)"
						:options="windowOptions"
						size="sm"
						:aria-label="t('dashboard.admin.delivery.dmarc.windowLabel')"
						@update:model-value="windowDays = Number($event) as DmarcWindowDays"
					/>
				</div>

				<!-- Where reports go and what the record still needs. -->
				<DomainsDmarcReportingPanel
					v-if="selected"
					:key="selected._id"
					:domain-id="selected._id"
					:domain="selected.domain"
					:dmarc-policy="selected.dmarcPolicy"
					:dmarc-subdomain-policy="selected.dmarcSubdomainPolicy"
					:dmarc-pct="selected.dmarcPct"
					can-manage
					:show-reports-link="false"
				/>

				<UiQueryBoundary
					:loading="summaryLoading && !summary"
					:error="summaryError"
					:empty="
						!!summary && summary.reportCount === 0 && summary.readiness.latestAlignedRate === null
					"
					@retry="refetchSummary"
				>
					<template #empty>
						<UiEmptyState
							icon="lucide:inbox"
							:title="t('dashboard.admin.delivery.dmarc.empty.title')"
							:description="t('dashboard.admin.delivery.dmarc.empty.description')"
						/>
					</template>

					<div v-if="summary" class="space-y-6" data-testid="dmarc-dashboard">
						<UiCard padding="none" overflow="hidden">
							<div class="p-6 space-y-6">
								<div class="grid grid-cols-1 gap-6 sm:grid-cols-3">
									<UiStatTile
										v-for="tile in tiles"
										:key="tile.key"
										:label="tile.label"
										:value="tile.value"
										:hint="tile.hint"
										:value-tone="tile.tone"
									/>
								</div>
								<div>
									<h2 class="mb-3 text-sm font-medium text-text-primary">
										{{ t('dashboard.admin.delivery.dmarc.trendTitle') }}
									</h2>
									<DeliveryDmarcTrendChart :points="summary.trend" />
								</div>
								<p v-if="summary.lastReportAt" class="text-xs text-text-tertiary">
									{{
										t('dashboard.admin.delivery.dmarc.lastReport', {
											when: formatRelativeTime(summary.lastReportAt),
										})
									}}
									<template v-if="summary.isTruncated">
										· {{ t('dashboard.admin.delivery.dmarc.truncated') }}
									</template>
								</p>
							</div>
						</UiCard>

						<UiCard>
							<h2 class="mb-4 text-lg font-semibold text-text-primary">
								{{ t('dashboard.admin.delivery.dmarc.readinessTitle') }}
							</h2>
							<DeliveryDmarcReadinessPanel
								:domain="summary.domain"
								:readiness="summary.readiness"
							/>
						</UiCard>

						<UiCard>
							<h2 class="text-lg font-semibold text-text-primary">
								{{ t('dashboard.admin.delivery.dmarc.sourcesTitle') }}
							</h2>
							<p class="mb-4 mt-0.5 text-sm text-text-secondary">
								{{ t('dashboard.admin.delivery.dmarc.sourcesSubtitle') }}
							</p>
							<DeliveryDmarcSourcesTable
								:sources="summary.sources"
								:total-count="summary.sourceCount"
							/>
						</UiCard>
					</div>
				</UiQueryBoundary>
			</div>
		</UiQueryBoundary>
	</div>
</template>
