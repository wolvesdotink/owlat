<script setup lang="ts">
import type { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { formatRelativeTime } from '~/utils/formatters';
import {
	auditActionLabel,
	scanLevelVariant,
	type OperatorReviewItem,
} from '~/utils/operatorConsole';

defineProps<{
	reviewQueue:
		| FunctionReturnType<typeof api.platformAdmin.queries.getContentReviewQueue>
		| undefined;
	/** An approval is in flight. */
	approving: boolean;
	/** Any console write is in flight; every action waits for it. */
	busy: boolean;
}>();

const emit = defineEmits<{
	approve: [item: OperatorReviewItem];
	reject: [item: OperatorReviewItem];
}>();

const { t } = useI18n();
</script>

<template>
	<div class="space-y-6">
		<div class="card">
			<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-4">
				{{ t('dashboard.admin.operator.index.review.title') }}
			</h3>

			<UiEmptyState
				v-if="!reviewQueue?.pending?.length"
				icon="lucide:check-circle-2"
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
							<UiBadge variant="neutral">{{ item.type }}</UiBadge>
							<span class="font-medium text-text-primary truncate">{{ item.name }}</span>
							<UiBadge v-if="item.scan" :variant="scanLevelVariant(item.scan.level)">
								{{ item.scan.level }} · {{ item.scan.score }}
							</UiBadge>
						</div>
						<p v-if="item.subject" class="mt-1 text-caption text-text-secondary truncate">
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
							:loading="approving"
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
