<script setup lang="ts">
/**
 * Update history (Settings → System & updates): the in-app update runs,
 * newest first, with their versions, start, duration and verdict.
 */
import { api } from '@owlat/api';
import { formatDateTime } from '~/utils/formatters';

const { t } = useI18n();

const {
	data: history,
	error: historyError,
	refetch: refetchHistory,
} = useConvexQuery(api.systemUpdates.listUpdateHistory, () => ({
	limit: 20,
}));

function formatDuration(start?: number, end?: number) {
	if (!start || !end) return '—';
	const sec = Math.floor((end - start) / 1000);
	if (sec < 60) return t('dashboard.admin.system.index.duration.seconds', { seconds: sec });
	return t('dashboard.admin.system.index.duration.minutes', {
		minutes: Math.floor(sec / 60),
		seconds: sec % 60,
	});
}
</script>

<template>
	<div class="card">
		<h3 class="font-semibold text-text-primary mb-4">
			{{ t('dashboard.admin.system.index.history.title') }}
		</h3>

		<!-- A failed read is not an empty history: show the error. -->
		<UiQueryBoundary v-if="historyError" :error="historyError" @retry="refetchHistory" />

		<div v-else-if="!history || history.length === 0" class="text-caption text-text-tertiary">
			{{ t('dashboard.admin.system.index.history.empty') }}
		</div>

		<!-- Scroll container: a from→to version pair plus three more columns
		     does not fit a phone, and without this the card just clipped them.
		     The negative margin lets the scroll area bleed to the card's edges. -->
		<div v-else class="-mx-6 px-6 overflow-x-auto">
			<table class="w-full min-w-max text-caption">
				<thead>
					<tr class="border-b border-border-subtle text-text-tertiary">
						<th class="text-left py-2 font-medium">
							{{ t('dashboard.admin.system.index.history.fromTo') }}
						</th>
						<th class="text-left py-2 font-medium">
							{{ t('dashboard.admin.system.index.history.started') }}
						</th>
						<th class="text-left py-2 font-medium">
							{{ t('dashboard.admin.system.index.history.duration') }}
						</th>
						<th class="text-left py-2 font-medium">{{ t('common.status') }}</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="row in history"
						:key="row._id"
						class="border-b border-border-subtle last:border-b-0"
					>
						<td class="py-2 font-mono text-text-primary">
							{{ row.versionFrom || '—' }} → {{ row.versionTo || '—' }}
						</td>
						<td class="py-2 text-text-secondary">{{ formatDateTime(row.startedAt) }}</td>
						<td class="py-2 text-text-secondary">
							{{ formatDuration(row.startedAt, row.finishedAt) }}
						</td>
						<td class="py-2">
							<span
								class="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full"
								:class="{
									'bg-success/10 text-success': row.status === 'success',
									'bg-error/10 text-error': row.status === 'failed',
									'bg-brand/10 text-brand': row.status === 'running',
									'bg-bg-surface text-text-tertiary': row.status === 'superseded',
								}"
							>
								<span
									class="w-1.5 h-1.5 rounded-full"
									:class="{
										'bg-success': row.status === 'success',
										'bg-error': row.status === 'failed',
										'bg-brand animate-pulse motion-reduce:animate-none': row.status === 'running',
										'bg-text-tertiary': row.status === 'superseded',
									}"
								/>
								{{ row.status }}
							</span>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
