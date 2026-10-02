<script setup lang="ts">
/**
 * Team Inbox response analytics: how fast the team answers, for the
 * conversations that started in the chosen range.
 *
 * Headline tiles (conversations, median and 90th-percentile first response,
 * median resolution, response-target hit rate), new conversations per day,
 * the daily median first response, and a per-assignee table. One axis per
 * chart, the brand hue only; the numbers live in the tiles and the table, so
 * nothing is carried by colour alone. Days are UTC days, like every other
 * dashboard. Owners and admins only, like the inbox itself.
 */
import { api } from '@owlat/api';
import { formatNumber, formatPercentage, formatUtcDayKey, formatDate } from '~/utils/formatters';
import {
	INBOX_ANALYTICS_PRESETS,
	inboxAnalyticsRange,
	inboxSlaDurationLabel,
	type InboxAnalyticsPreset,
} from '~/utils/inboxSla';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.inbox.analytics.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

const { isAdmin, showAdminGate } = usePermissions();

// ── Range: a quick preset, or two dates ──
const preset = ref<InboxAnalyticsPreset>('30');
const custom = reactive({ from: '', to: '' });
const presetOptions = computed(() => [
	...INBOX_ANALYTICS_PRESETS.map((days) => ({
		value: days,
		label: t('dashboard.inbox.analytics.range.lastDays', { days }),
	})),
	{ value: 'custom', label: t('dashboard.inbox.analytics.range.custom') },
]);
const range = computed(() => inboxAnalyticsRange(preset.value, custom, Date.now()));
// Seed the custom fields from the current preset, so switching starts from it.
watch(preset, (next, previous) => {
	if (next !== 'custom' || previous === 'custom') return;
	const seeded = inboxAnalyticsRange(previous, custom, Date.now());
	if (seeded) Object.assign(custom, { from: seeded.fromDay, to: seeded.toDay });
});

const {
	data: analytics,
	isLoading,
	error,
	refetch,
} = useConvexQuery(
	api.inbox.sla.queries.getAnalytics,
	() => (isAdmin.value && range.value ? range.value : 'skip'),
	{ keepPreviousData: true }
);

// The history back-fill (migration 0065) starts the first time anyone opens
// this page; it fills first-response and resolution times for older threads.
const { run: startHistory } = useBackendOperation(api.inbox.sla.queries.startHistoryBackfill, {
	label: () => t('dashboard.inbox.analytics.history.operation'),
	announce: false,
});
let historyRequested = false;
watch(
	() => analytics.value?.history,
	(history) => {
		if (history !== 'not_started' || historyRequested) return;
		historyRequested = true;
		void startHistory({});
	},
	{ immediate: true }
);

function duration(ms: number | undefined | null): string {
	if (ms === undefined || ms === null) return '—';
	const label = inboxSlaDurationLabel(ms);
	return t(label.key, label.params);
}

const tiles = computed(() => {
	const data = analytics.value;
	if (!data) return [];
	const hitRate = data.targets.hitRate;
	return [
		{
			key: 'conversations',
			label: t('dashboard.inbox.analytics.tiles.conversations'),
			value: formatNumber(data.conversations),
		},
		{
			key: 'firstResponse',
			label: t('dashboard.inbox.analytics.tiles.medianFirstResponse'),
			value: duration(data.firstResponse?.median),
			hint: data.firstResponse
				? t('dashboard.inbox.analytics.tiles.p90', { value: duration(data.firstResponse.p90) })
				: t('dashboard.inbox.analytics.tiles.noReplies'),
		},
		{
			key: 'resolution',
			label: t('dashboard.inbox.analytics.tiles.medianResolution'),
			value: duration(data.resolution?.median),
			hint: data.resolution
				? t('dashboard.inbox.analytics.tiles.p90', { value: duration(data.resolution.p90) })
				: t('dashboard.inbox.analytics.tiles.noneResolved'),
		},
		{
			key: 'hitRate',
			label: t('dashboard.inbox.analytics.tiles.hitRate'),
			value: hitRate === null ? '—' : formatPercentage(hitRate, 0),
			hint:
				hitRate === null
					? t('dashboard.inbox.analytics.tiles.noTargets')
					: t('dashboard.inbox.analytics.tiles.hitRateHint', {
							met: data.targets.met,
							missed: data.targets.missed,
						}),
			tone:
				hitRate === null
					? ('default' as const)
					: hitRate >= 0.9
						? ('success' as const)
						: hitRate >= 0.75
							? ('warning' as const)
							: ('error' as const),
		},
	];
});

const volumeSeries = computed(() =>
	(analytics.value?.daily ?? []).map((d) => ({
		label: formatUtcDayKey(d.date, locale.value),
		value: d.conversations,
	}))
);
// Days without a reply have no median: they are left out rather than drawn as zero.
const firstResponseSeries = computed(() =>
	(analytics.value?.daily ?? []).flatMap((d) =>
		d.medianFirstResponseMs === null
			? []
			: [
					{
						label: formatUtcDayKey(d.date, locale.value),
						value: Math.round(d.medianFirstResponseMs / 60_000),
					},
				]
	)
);
const formatMinutes = (minutes: number) => duration(minutes * 60_000);
const labelEvery = computed(() => Math.max(1, Math.ceil(volumeSeries.value.length / 8)));
</script>

<template>
	<div class="mx-auto w-full max-w-page p-6 lg:p-8">
		<UiPageHeader
			class="mb-6"
			:title="t('dashboard.inbox.analytics.title')"
			:description="t('dashboard.inbox.analytics.subtitle')"
		>
			<template #actions>
				<UiButton to="/dashboard/inbox/response-targets" variant="secondary" class="gap-2">
					<Icon name="lucide:alarm-clock" class="w-4 h-4" />
					{{ t('dashboard.inbox.analytics.targetsLink') }}
				</UiButton>
				<UiButton to="/dashboard/inbox" variant="ghost" class="gap-2">
					<Icon name="lucide:inbox" class="w-4 h-4" />
					{{ t('dashboard.inbox.analytics.backToInbox') }}
				</UiButton>
			</template>
		</UiPageHeader>

		<div v-if="showAdminGate" class="py-20 text-center text-text-secondary">
			{{ t('dashboard.inbox.analytics.adminOnly') }}
		</div>

		<template v-else>
			<!-- Range: one row of controls above every chart. -->
			<div class="mb-6 flex flex-wrap items-end gap-3" data-testid="inbox-analytics-range">
				<UiSegmentedControl v-model="preset" :options="presetOptions" size="sm" fit="content" />
				<template v-if="preset === 'custom'">
					<UiInput
						v-model="custom.from"
						type="date"
						size="sm"
						:label="t('dashboard.inbox.analytics.range.from')"
					/>
					<UiInput
						v-model="custom.to"
						type="date"
						size="sm"
						:label="t('dashboard.inbox.analytics.range.to')"
					/>
				</template>
			</div>
			<p v-if="!range" class="mb-6 text-sm text-warning">
				{{ t('dashboard.inbox.analytics.range.invalid') }}
			</p>

			<UiQueryBoundary
				:loading="isLoading && !analytics"
				:error="error"
				:error-title="t('dashboard.inbox.analytics.errorTitle')"
				@retry="refetch"
			>
				<template #loading>
					<div class="grid grid-cols-2 lg:grid-cols-4 gap-6" role="status" aria-live="polite">
						<div
							v-for="n in 4"
							:key="n"
							class="h-20 animate-pulse motion-reduce:animate-none rounded-xl bg-bg-surface"
						/>
					</div>
				</template>

				<div v-if="analytics" class="space-y-6">
					<div
						v-if="!analytics.isTargetsEnabled || analytics.history === 'running'"
						class="space-y-1 text-sm text-text-secondary"
					>
						<p v-if="!analytics.isTargetsEnabled" data-testid="inbox-analytics-targets-off">
							{{ t('dashboard.inbox.analytics.targetsOff') }}
							<NuxtLink to="/dashboard/inbox/response-targets" class="text-brand hover:underline">
								{{ t('dashboard.inbox.analytics.targetsOffLink') }}
							</NuxtLink>
						</p>
						<p v-if="analytics.history === 'running'">
							{{ t('dashboard.inbox.analytics.history.running') }}
						</p>
					</div>

					<div class="grid grid-cols-2 lg:grid-cols-4 gap-6" data-testid="inbox-analytics-tiles">
						<UiStatTile
							v-for="tile in tiles"
							:key="tile.key"
							:label="tile.label"
							:value="tile.value"
							:hint="tile.hint"
							:value-tone="tile.tone ?? 'default'"
						/>
					</div>

					<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
						<UiCard>
							<h2 class="text-sm font-medium text-text-primary mb-3">
								{{ t('dashboard.inbox.analytics.volume.title') }}
							</h2>
							<UiBars
								:data="volumeSeries"
								:label-every="labelEvery"
								:aria-label="t('dashboard.inbox.analytics.volume.title')"
							/>
						</UiCard>
						<UiCard>
							<h2 class="text-sm font-medium text-text-primary mb-3">
								{{ t('dashboard.inbox.analytics.firstResponse.title') }}
							</h2>
							<UiTrendChart
								:data="firstResponseSeries"
								:format-value="formatMinutes"
								:show-area="false"
								:aria-label="t('dashboard.inbox.analytics.firstResponse.title')"
							/>
						</UiCard>
					</div>

					<UiCard>
						<h2 class="text-sm font-medium text-text-primary mb-3">
							{{ t('dashboard.inbox.analytics.assignees.title') }}
						</h2>
						<InboxSlaAssigneeTable
							v-if="analytics.assignees.length > 0"
							:rows="analytics.assignees"
							:names="analytics.assigneeNames"
						/>
						<p v-else class="text-sm text-text-tertiary">
							{{ t('dashboard.inbox.analytics.assignees.empty') }}
						</p>
					</UiCard>

					<p class="text-xs text-text-tertiary">
						{{ t('dashboard.inbox.analytics.footnote') }}
						<template v-if="analytics.isTruncated">
							{{
								t('dashboard.inbox.analytics.truncated', {
									date: formatDate(analytics.completeFromMs),
								})
							}}
						</template>
					</p>
				</div>
			</UiQueryBoundary>
		</template>
	</div>
</template>
