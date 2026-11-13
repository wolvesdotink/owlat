<script setup lang="ts">
import type { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { formatRelativeTime } from '~/utils/formatters';
import {
	auditActionLabel,
	scanLevelVariant,
	type OperatorReviewItem,
} from '~/utils/operatorConsole';
import { CircleCheckIcon } from '@coolicons/vue';

defineProps<{
	reviewQueue:
		| FunctionReturnType<typeof api.platformAdmin.queries.getContentReviewQueue>
		| undefined;
	/** `${type}-${id}` of the item whose approval is in flight, if any. */
	approvingKey: string | null;
	/** Any console write is in flight; every action waits for it. */
	busy: boolean;
}>();

const emit = defineEmits<{
	approve: [item: OperatorReviewItem];
	reject: [item: OperatorReviewItem];
}>();

const { t, te } = useI18n();

/**
 * The words for a backend enum value. A value with no copy of its own falls
 * back to the raw value, which beats a blank badge.
 */
function enumLabel(group: 'scanLevel' | 'resourceType', value: string | undefined): string {
	if (!value) return '—';
	const key = `dashboard.admin.operator.index.${group}.${value}`;
	return te(key) ? t(key) : value;
}
</script>

<template>
	<div class="space-y-6">
		<div class="card">
			<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-4">
				{{ t('dashboard.admin.operator.index.review.title') }}
			</h3>

			<UiEmptyState
				v-if="!reviewQueue?.pending?.length"
				:icon="CircleCheckIcon"
				:title="t('dashboard.admin.operator.index.review.emptyTitle')"
				:description="t('dashboard.admin.operator.index.review.emptyDescription')"
			/>

			<div v-else class="space-y-3">
				<div
					v-for="item in reviewQueue.pending as OperatorReviewItem[]"
					:key="`${item.type}-${item.id}`"
					class="flex items-start justify-between gap-4 rounded-lg shadow-surface-1 p-4"
				>
					<div class="min-w-0">
						<div class="flex items-center gap-2 flex-wrap">
							<UiBadge variant="neutral">{{ enumLabel('resourceType', item.type) }}</UiBadge>
							<span class="font-medium text-text-primary truncate" :title="item.name">{{
								item.name
							}}</span>
							<UiBadge v-if="item.scan" :variant="scanLevelVariant(item.scan.level)">
								{{
									t('dashboard.admin.operator.index.review.scanScore', {
										level: enumLabel('scanLevel', item.scan.level),
										score: item.scan.score,
									})
								}}
							</UiBadge>
						</div>
						<p
							v-if="item.subject"
							class="mt-1 text-caption text-text-secondary truncate"
							:title="item.subject"
						>
							{{ item.subject }}
						</p>
						<p class="mt-1 text-xs text-text-tertiary">
							{{
								t('dashboard.admin.operator.index.review.updated', {
									time: formatRelativeTime(item.updatedAt),
								})
							}}
						</p>
					</div>
					<div class="flex gap-2 shrink-0">
						<UiButton
							variant="primary"
							size="sm"
							:loading="approvingKey === `${item.type}-${item.id}`"
							:disabled="busy"
							@click="emit('approve', item)"
						>
							{{ t('dashboard.admin.operator.index.review.approve') }}
						</UiButton>
						<UiButton
							variant="danger-outline"
							size="sm"
							:disabled="busy"
							@click="emit('reject', item)"
						>
							{{ t('dashboard.admin.operator.index.review.reject') }}
						</UiButton>
					</div>
				</div>
			</div>
		</div>

		<!-- Recently reviewed -->
		<div v-if="reviewQueue?.recentlyReviewed?.length" class="card">
			<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-4">
				{{ t('dashboard.admin.operator.index.review.recentlyReviewed') }}
			</h3>
			<ul class="space-y-2">
				<li
					v-for="(a, i) in reviewQueue.recentlyReviewed"
					:key="i"
					class="flex items-center justify-between text-caption"
				>
					<span class="text-text-primary">{{ t(auditActionLabel(a.action)) }}</span>
					<span class="text-text-tertiary">{{ formatRelativeTime(a.createdAt) }}</span>
				</li>
			</ul>
		</div>
	</div>
</template>
