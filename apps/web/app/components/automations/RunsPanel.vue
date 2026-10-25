<script setup lang="ts">
/**
 * The contacts in an automation (its runs), newest first, ten at a time.
 *
 * The filter lives in the URL (`?runs=`), so the automations list can link
 * straight to the runs behind a health count: `?runs=failed` lists the runs a
 * failed step ended and `?runs=stalled` the runs the stalled-run sweep ended,
 * both over the list's last 7 days. The other values filter by run status.
 */
import { api } from '@owlat/api';
import type { Doc, Id } from '@owlat/api/dataModel';
import { formatCompactRelativeTime } from '~/utils/formatters';

const props = defineProps<{ automationId: Id<'automations'> }>();

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const RUN_FILTERS = ['all', 'running', 'completed', 'cancelled', 'failed', 'stalled'] as const;
type RunFilter = (typeof RUN_FILTERS)[number];

const isRunFilter = (value: unknown): value is RunFilter =>
	typeof value === 'string' && (RUN_FILTERS as readonly string[]).includes(value);

const selectedFilter = computed<RunFilter>({
	get: () => (isRunFilter(route.query['runs']) ? route.query['runs'] : 'all'),
	set: (value) =>
		void router.replace({
			query: { ...route.query, runs: value === 'all' ? undefined : value },
		}),
});

const pageSize = 10;
const runsOffset = ref(0);

// A new filter starts from the first page.
watch(selectedFilter, () => {
	runsOffset.value = 0;
});

const {
	data: runs,
	isLoading: runsLoading,
	error: runsError,
	refetch: refetchRuns,
} = useConvexQuery(api.automations.analytics.getAutomationRuns, () => {
	const filter = selectedFilter.value;
	return {
		automationId: props.automationId,
		...(filter === 'failed'
			? { endReason: 'step_failed' as const }
			: filter === 'stalled'
				? { endReason: 'stalled' as const }
				: filter === 'all'
					? {}
					: { status: filter }),
		limit: pageSize,
		offset: runsOffset.value,
	};
});

const runFilters = computed(() => [
	{ value: 'all' as const, label: t('common.all') },
	{ value: 'running' as const, label: t('dashboard.automations.detail.index.runs.inProgress') },
	{ value: 'completed' as const, label: t('dashboard.automations.detail.index.runs.completed') },
	{ value: 'cancelled' as const, label: t('dashboard.automations.detail.index.runs.cancelled') },
	{ value: 'failed' as const, label: t('dashboard.automations.detail.index.runs.failed') },
	{ value: 'stalled' as const, label: t('dashboard.automations.detail.index.runs.stalled') },
]);

/** What a health filter lists, said under the header. */
const filterNote = computed(() => {
	switch (selectedFilter.value) {
		case 'failed':
			return t('dashboard.automations.detail.index.runs.failedNote');
		case 'stalled':
			return t('dashboard.automations.detail.index.runs.stalledNote');
		default:
			return null;
	}
});

type RunBadge = { color: string; icon: string; label: string; animated: boolean };

const getRunStatusBadge = (run: Pick<Doc<'automationRuns'>, 'status' | 'endReason'>): RunBadge => {
	switch (run.status) {
		case 'running':
			return {
				color: 'bg-brand/10 text-brand',
				icon: 'lucide:loader-2',
				label: t('dashboard.automations.detail.index.runs.inProgress'),
				animated: true,
			};
		case 'completed':
			return {
				color: 'bg-success/10 text-success',
				icon: 'lucide:check-circle-2',
				label: t('dashboard.automations.detail.index.runs.completed'),
				animated: false,
			};
		case 'cancelled':
			if (run.endReason === 'step_failed') {
				return {
					color: 'bg-error/10 text-error',
					icon: 'lucide:alert-circle',
					label: t('dashboard.automations.detail.index.runs.failed'),
					animated: false,
				};
			}
			if (run.endReason === 'stalled') {
				return {
					color: 'bg-warning/10 text-warning',
					icon: 'lucide:circle-pause',
					label: t('dashboard.automations.detail.index.runs.stalled'),
					animated: false,
				};
			}
			return {
				color: 'bg-error/10 text-error',
				icon: 'lucide:x-circle',
				label: t('dashboard.automations.detail.index.runs.cancelled'),
				animated: false,
			};
	}
};

const loadMoreRuns = () => {
	if (runs.value?.hasMore) runsOffset.value += pageSize;
};

const loadPrevRuns = () => {
	if (runsOffset.value > 0) runsOffset.value = Math.max(0, runsOffset.value - pageSize);
};
</script>

<template>
	<div class="card p-0 overflow-hidden">
		<div class="px-6 py-4 border-b border-border-subtle">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h3 class="text-lg font-medium text-text-primary">
					{{ t('dashboard.automations.detail.index.runs.title') }}
				</h3>
				<!-- Status filter: scrolls on a phone instead of widening the page -->
				<div class="max-w-full overflow-x-auto">
					<UiSegmentedControl
						:model-value="selectedFilter"
						:options="runFilters"
						size="sm"
						:aria-label="t('dashboard.automations.detail.index.runs.statusFilterLabel')"
						class="min-w-max"
						@update:model-value="selectedFilter = $event as RunFilter"
					/>
				</div>
			</div>
			<p v-if="filterNote" class="mt-2 text-sm text-text-tertiary">{{ filterNote }}</p>
		</div>

		<!-- Loading -->
		<div v-if="runsLoading && !runs" class="p-8 flex justify-center">
			<Icon
				name="lucide:loader-2"
				class="w-6 h-6 text-brand animate-spin motion-reduce:animate-none"
			/>
		</div>

		<UiQueryBoundary v-else-if="runsError" :error="runsError" @retry="refetchRuns" />

		<!-- Empty state -->
		<div v-else-if="!runs || runs.runs.length === 0" class="py-12 text-center">
			<Icon name="lucide:users" class="w-10 h-10 text-text-tertiary mx-auto mb-3" />
			<template v-if="selectedFilter === 'all'">
				<p class="text-text-secondary">
					{{ t('dashboard.automations.detail.index.runs.emptyTitle') }}
				</p>
				<p class="text-sm text-text-tertiary mt-1">
					{{ t('dashboard.automations.detail.index.runs.emptyDescription') }}
				</p>
			</template>
			<p v-else class="text-text-secondary">
				{{ t('dashboard.automations.detail.index.runs.emptyFiltered') }}
			</p>
		</div>

		<!-- Contacts table -->
		<div v-else>
			<div class="divide-y divide-border-subtle">
				<div
					v-for="run in runs.runs"
					:key="run._id"
					class="px-6 py-4 flex items-center justify-between hover:bg-bg-surface transition-colors"
				>
					<div class="flex items-center gap-3 min-w-0">
						<UiIconBox icon="lucide:users" size="lg" rounded="full" />
						<div class="min-w-0">
							<div class="text-text-primary font-medium truncate">
								{{
									run.contact?.firstName || run.contact?.email?.split('@')[0] || t('common.unknown')
								}}
								{{ run.contact?.lastName || '' }}
							</div>
							<div class="text-sm text-text-tertiary truncate">
								{{ run.contact?.email || t('dashboard.automations.detail.index.runs.noEmail') }}
							</div>
						</div>
					</div>
					<div class="flex items-center gap-4 shrink-0">
						<div class="text-right">
							<span
								:class="[
									'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium',
									getRunStatusBadge(run).color,
								]"
							>
								<Icon
									:name="getRunStatusBadge(run).icon"
									:class="[
										'w-3 h-3',
										getRunStatusBadge(run).animated
											? 'animate-spin motion-reduce:animate-none'
											: '',
									]"
								/>
								{{ getRunStatusBadge(run).label }}
							</span>
							<div class="text-xs text-text-tertiary mt-1">
								{{
									t('dashboard.automations.detail.index.runs.stepAndTime', {
										number: run.currentStepIndex + 1,
										time: formatCompactRelativeTime(run.startedAt, { emptyLabel: '—' }),
									})
								}}
							</div>
						</div>
						<UiTooltip
							v-if="run.contact"
							:text="t('dashboard.automations.detail.index.runs.viewContact')"
						>
							<NuxtLink
								:to="`/dashboard/audience/contacts/${run.contact._id}`"
								class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
								:aria-label="t('dashboard.automations.detail.index.runs.viewContact')"
							>
								<Icon name="lucide:chevron-right" class="w-4 h-4" />
							</NuxtLink>
						</UiTooltip>
					</div>
				</div>
			</div>

			<!-- Pagination -->
			<div
				v-if="runsOffset > 0 || runs.hasMore"
				class="px-6 py-4 border-t border-border-subtle flex items-center justify-between"
			>
				<UiButton
					variant="secondary"
					class="text-sm"
					:disabled="runsOffset === 0"
					@click="loadPrevRuns"
				>
					{{ t('dashboard.automations.detail.index.runs.previous') }}
				</UiButton>
				<span class="text-sm text-text-tertiary">
					{{
						t('dashboard.automations.detail.index.runs.range', {
							from: runsOffset + 1,
							to: runsOffset + (runs.runs?.length ?? 0),
						})
					}}
				</span>
				<UiButton
					variant="secondary"
					class="text-sm"
					:disabled="!runs.hasMore"
					@click="loadMoreRuns"
				>
					{{ t('dashboard.automations.detail.index.runs.next') }}
				</UiButton>
			</div>
		</div>
	</div>
</template>
