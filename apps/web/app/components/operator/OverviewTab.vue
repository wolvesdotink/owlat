<script setup lang="ts">
import type { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { formatNumber, formatRelativeTime } from '~/utils/formatters';
import { abuseStatusVariant, formatRate, scanLevelVariant } from '~/utils/operatorConsole';

defineProps<{
	stats: FunctionReturnType<typeof api.platformAdmin.queries.getPlatformStats> | undefined;
	recentAbuse: FunctionReturnType<typeof api.platformAdmin.queries.listRecentAbuse> | undefined;
	showDeliveryStats: boolean;
}>();

const { t, locale } = useI18n();

/** Counts written the way the reader's locale writes them ("128,400", "128.400"). */
const formatCount = (value: number | undefined | null) => formatNumber(value, locale.value);
const formatPercent = (value: number | undefined) => formatRate(value, locale.value);
</script>

<template>
	<div class="space-y-6">
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
			<template v-if="showDeliveryStats">
				<div class="card p-5">
					<p class="text-xs text-text-tertiary uppercase tracking-wider">
						{{ t('dashboard.admin.operator.index.stats.totalSent') }}
					</p>
					<p class="mt-1 text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ formatCount(stats?.sending?.totalSent) }}
					</p>
				</div>
				<div class="card p-5">
					<p class="text-xs text-text-tertiary uppercase tracking-wider">
						{{ t('dashboard.admin.operator.index.stats.bounceRate') }}
					</p>
					<p class="mt-1 text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ formatPercent(stats?.sending?.bounceRate) }}
					</p>
				</div>
				<div class="card p-5">
					<p class="text-xs text-text-tertiary uppercase tracking-wider">
						{{ t('dashboard.admin.operator.index.stats.complaintRate') }}
					</p>
					<p class="mt-1 text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ formatPercent(stats?.sending?.complaintRate) }}
					</p>
				</div>
			</template>
			<div class="card p-5">
				<p class="text-xs text-text-tertiary uppercase tracking-wider">
					{{ t('dashboard.admin.operator.index.stats.abuseStatus') }}
				</p>
				<div class="mt-1.5">
					<UiBadge :variant="abuseStatusVariant(stats?.abuseStatus)" size="md">
						{{ stats?.abuseStatus ?? 'clean' }}
					</UiBadge>
				</div>
			</div>
		</div>

		<!-- Recent abuse signals -->
		<div class="card">
			<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-4">
				{{ t('dashboard.admin.operator.index.abuse.title') }}
			</h3>
			<div
				v-if="
					!recentAbuse || (!recentAbuse.flaggedScans?.length && !recentAbuse.pendingReview?.length)
				"
				class="text-caption text-text-tertiary"
			>
				{{ t('dashboard.admin.operator.index.abuse.empty') }}
			</div>
			<div v-else class="space-y-4">
				<div v-if="recentAbuse.pendingReview?.length">
					<p class="text-xs font-medium text-text-secondary mb-2">
						{{
							t('dashboard.admin.operator.index.abuse.pendingReview', {
								count: recentAbuse.pendingReview.length,
							})
						}}
					</p>
					<ul class="space-y-1">
						<li
							v-for="c in recentAbuse.pendingReview"
							:key="c.id"
							class="flex items-center justify-between text-caption text-text-primary"
						>
							<span>{{ c.name }}</span>
							<span class="text-text-tertiary">{{ formatRelativeTime(c.updatedAt) }}</span>
						</li>
					</ul>
				</div>
				<div v-if="recentAbuse.flaggedScans?.length">
					<p class="text-xs font-medium text-text-secondary mb-2">
						{{
							t('dashboard.admin.operator.index.abuse.flaggedScans', {
								count: recentAbuse.flaggedScans.length,
							})
						}}
					</p>
					<ul class="space-y-1">
						<li
							v-for="(s, i) in recentAbuse.flaggedScans"
							:key="`${s.resourceType}-${s.resourceId}-${i}`"
							class="flex items-center justify-between text-caption"
						>
							<span class="text-text-primary">
								{{
									t('dashboard.admin.operator.index.abuse.scanEntry', {
										resourceType: s.resourceType,
										score: s.score,
									})
								}}
							</span>
							<UiBadge :variant="scanLevelVariant(s.level)">{{ s.level }}</UiBadge>
						</li>
					</ul>
				</div>
			</div>
		</div>
	</div>
</template>
