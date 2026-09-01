<script setup lang="ts">
import { api } from '@owlat/api';
import { formatNumber } from '~/utils/formatters';

const { t, locale } = useI18n();

/**
 * Passed to UiNumberTicker, which formats every in-flight frame of the tween.
 * The ticker captures the formatter at setup, so the element is keyed on
 * `locale` in the template to re-render the current value on a language switch.
 */
function formatCount(value: number): string {
	return formatNumber(Math.round(value), locale.value);
}

const { data: stats, isLoading } = useOrganizationQuery(api.inbox.queries.getInboundStats);

const pendingCount = computed(() => stats.value?.draftReady ?? 0);
const processingCount = computed(() => stats.value?.processing ?? 0);
const openThreads = computed(() => stats.value?.openThreads ?? 0);
</script>

<template>
	<UiCard class="h-full" padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:inbox" size="sm" variant="surface" />
					<h3 class="text-sm font-semibold text-text-primary">
						{{ t('components.dashboard.cards.verificationQueueCard.title') }}
					</h3>
				</div>
				<NuxtLink
					to="/dashboard/inbox/review"
					class="text-xs font-medium whitespace-nowrap text-text-secondary hover:text-brand transition-colors"
				>
					{{ t('common.viewAll') }}
				</NuxtLink>
			</div>

			<DashboardCardSkeleton v-if="isLoading" shape="metrics" hero :count="2" />

			<div v-else>
				<div class="flex items-baseline gap-2 mb-4">
					<span class="text-3xl font-bold tabular-nums text-text-primary">
						<UiNumberTicker :key="locale" :value="pendingCount" :formatter="formatCount" />
					</span>
					<span class="text-sm text-text-secondary">
						{{ t('components.dashboard.cards.verificationQueueCard.draftsAwaitingReview') }}
					</span>
				</div>

				<div class="grid grid-cols-2 gap-3">
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<p class="text-xs text-text-tertiary">
							{{ t('components.dashboard.cards.verificationQueueCard.processing') }}
						</p>
						<p class="text-lg font-semibold tabular-nums text-text-primary">
							{{ formatCount(processingCount) }}
						</p>
					</div>
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<p class="text-xs text-text-tertiary">
							{{ t('components.dashboard.cards.verificationQueueCard.openThreads') }}
						</p>
						<p class="text-lg font-semibold tabular-nums text-text-primary">
							{{ formatCount(openThreads) }}
						</p>
					</div>
				</div>
			</div>
		</div>
	</UiCard>
</template>
