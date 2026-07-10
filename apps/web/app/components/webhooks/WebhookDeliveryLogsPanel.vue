<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { capitalize, formatDateTime } from '~/utils/formatters';

interface WebhookDeliveryLog {
	_id: Id<'webhookDeliveryLogs'>;
	event: string;
	status: 'pending' | 'success' | 'failed' | 'retrying';
	httpStatusCode?: number;
	durationMs?: number;
	scheduledAt: number;
	attemptNumber: number;
	maxAttempts: number;
	payload: { event: string; timestamp: string; data: Record<string, string | number | boolean | null> };
	responseBody?: string;
	errorMessage?: string;
	attemptedAt?: number;
	completedAt?: number;
	nextRetryAt?: number;
}

interface Props {
	isOpen: boolean;
	webhookName: string;
	webhookId: Id<'webhooks'> | null;
	logs: WebhookDeliveryLog[] | undefined;
	logsLoading: boolean;
	stats: { total: number; success: number; failed: number; pending: number; retrying: number; successRate: number } | undefined;
	selectedLogId: Id<'webhookDeliveryLogs'> | null;
	selectedLog: WebhookDeliveryLog | null | undefined;
	isSendingTest: boolean;
}

defineProps<Props>();

const emit = defineEmits<{
	close: [];
	selectLog: [logId: Id<'webhookDeliveryLogs'>];
	clearSelectedLog: [];
	sendTest: [];
}>();

function statusColor(status: string) {
	switch (status) {
		case 'success': return 'bg-success/10 text-success';
		case 'failed': return 'bg-error/10 text-error';
		case 'retrying': return 'bg-warning/10 text-warning';
		case 'pending': return 'bg-brand-subtle text-brand';
		default: return 'bg-bg-surface text-text-tertiary';
	}
}

function formatDuration(ms: number | undefined) {
	if (ms === undefined) return '-';
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function formatEventLabel(event: string) {
	if (event === 'test') return 'Test';
	return event
		.split('.')
		.map((s) => capitalize(s))
		.join(' ');
}

function formatJson(value: unknown) {
	if (typeof value === 'string') {
		try {
			return JSON.stringify(JSON.parse(value), null, 2);
		} catch {
			return value;
		}
	}
	return JSON.stringify(value, null, 2);
}
</script>

<template>
	<UiModal
		:open="isOpen"
		:title="selectedLogId ? 'Delivery Detail' : `Delivery Logs — ${webhookName}`"
		size="2xl"
		@update:open="(v) => { if (!v) emit('close'); }"
	>
		<!-- Sub-header toolbar: back navigation + send test -->
		<div
			v-if="selectedLogId || !logsLoading || logs"
			class="flex items-center justify-between mb-4 min-h-[2rem]"
		>
			<button
				v-if="selectedLogId"
				class="flex items-center gap-1 text-sm text-text-tertiary hover:text-text-primary transition-colors"
				@click="emit('clearSelectedLog')"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Back to logs
			</button>
			<span v-else />
			<button
				v-if="!selectedLogId"
				class="btn btn-secondary gap-2 text-sm"
				:disabled="isSendingTest"
				@click="emit('sendTest')"
			>
				<Icon v-if="isSendingTest" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
				<Icon v-else name="lucide:send" class="w-4 h-4" />
				{{ isSendingTest ? 'Sending...' : 'Send Test' }}
			</button>
		</div>

		<!-- Stats Bar -->
		<div v-if="!selectedLogId && stats && stats.total > 0" class="mb-4 py-3 border-y border-border-subtle grid grid-cols-4 gap-4">
			<div class="text-center">
				<p class="text-lg font-semibold text-text-primary">{{ stats.total }}</p>
				<p class="text-xs text-text-tertiary">Total</p>
			</div>
			<div class="text-center">
				<p class="text-lg font-semibold text-success">{{ stats.success }}</p>
				<p class="text-xs text-text-tertiary">Success</p>
			</div>
			<div class="text-center">
				<p class="text-lg font-semibold text-error">{{ stats.failed }}</p>
				<p class="text-xs text-text-tertiary">Failed</p>
			</div>
			<div class="text-center">
				<p class="text-lg font-semibold text-text-primary">{{ stats.successRate }}%</p>
				<p class="text-xs text-text-tertiary">Success Rate</p>
			</div>
		</div>

		<!-- Content area -->
		<div class="overflow-y-auto max-h-[60vh] -mx-6">
			<!-- Loading -->
			<div v-if="logsLoading && !logs" class="flex items-center justify-center py-16">
				<UiSpinner size="md" />
			</div>

			<!-- Selected log detail -->
			<div v-else-if="selectedLogId && selectedLog" class="px-6 space-y-4">
				<!-- Status + attempt -->
				<div class="flex items-center gap-3">
					<span :class="['inline-flex items-center px-2.5 py-1 rounded text-xs font-medium', statusColor(selectedLog.status)]">
						{{ selectedLog.status }}
					</span>
					<span class="text-sm text-text-secondary">
						Attempt {{ selectedLog.attemptNumber }}/{{ selectedLog.maxAttempts }}
					</span>
					<span class="text-sm text-text-secondary">
						{{ formatEventLabel(selectedLog.event) }}
					</span>
				</div>

				<!-- HTTP status -->
				<div v-if="selectedLog.httpStatusCode">
					<p class="text-xs text-text-tertiary mb-1">HTTP Status</p>
					<p class="text-sm text-text-primary font-mono">{{ selectedLog.httpStatusCode }}</p>
				</div>

				<!-- Error message -->
				<div v-if="selectedLog.errorMessage">
					<p class="text-xs text-text-tertiary mb-1">Error</p>
					<p class="text-sm text-error font-mono break-all">{{ selectedLog.errorMessage }}</p>
				</div>

				<!-- Timing -->
				<div class="grid grid-cols-2 gap-4">
					<div>
						<p class="text-xs text-text-tertiary mb-1">Scheduled At</p>
						<p class="text-sm text-text-secondary">{{ formatDateTime(selectedLog.scheduledAt) }}</p>
					</div>
					<div v-if="selectedLog.attemptedAt">
						<p class="text-xs text-text-tertiary mb-1">Attempted At</p>
						<p class="text-sm text-text-secondary">{{ formatDateTime(selectedLog.attemptedAt) }}</p>
					</div>
					<div v-if="selectedLog.completedAt">
						<p class="text-xs text-text-tertiary mb-1">Completed At</p>
						<p class="text-sm text-text-secondary">{{ formatDateTime(selectedLog.completedAt) }}</p>
					</div>
					<div v-if="selectedLog.durationMs !== undefined">
						<p class="text-xs text-text-tertiary mb-1">Duration</p>
						<p class="text-sm text-text-secondary">{{ formatDuration(selectedLog.durationMs) }}</p>
					</div>
				</div>

				<!-- Request payload -->
				<div>
					<p class="text-xs text-text-tertiary mb-1">Request Payload</p>
					<pre class="text-xs font-mono bg-bg-deep border border-border-subtle rounded-lg p-3 overflow-x-auto text-text-secondary">{{ formatJson(selectedLog.payload) }}</pre>
				</div>

				<!-- Response body -->
				<div v-if="selectedLog.responseBody">
					<p class="text-xs text-text-tertiary mb-1">Response Body</p>
					<pre class="text-xs font-mono bg-bg-deep border border-border-subtle rounded-lg p-3 overflow-x-auto text-text-secondary">{{ selectedLog.responseBody }}</pre>
				</div>
			</div>

			<!-- Logs list -->
			<div v-else-if="logs && logs.length > 0">
				<div
					v-for="log in logs"
					:key="log._id"
					class="flex items-center gap-4 px-6 py-3 border-b border-border-subtle hover:bg-bg-surface/50 cursor-pointer transition-colors"
					@click="emit('selectLog', log._id)"
				>
					<span :class="['inline-flex items-center px-2 py-0.5 rounded text-xs font-medium shrink-0', statusColor(log.status)]">
						{{ log.status }}
					</span>
					<span class="text-sm text-text-primary min-w-0 truncate">
						{{ formatEventLabel(log.event) }}
					</span>
					<span v-if="log.httpStatusCode" class="text-xs text-text-tertiary font-mono shrink-0">
						{{ log.httpStatusCode }}
					</span>
					<span class="text-xs text-text-tertiary shrink-0">
						{{ formatDuration(log.durationMs) }}
					</span>
					<span class="text-xs text-text-tertiary shrink-0 ml-auto">
						{{ formatDateTime(log.scheduledAt) }}
					</span>
					<Icon name="lucide:chevron-right" class="w-4 h-4 text-text-tertiary shrink-0" />
				</div>
			</div>

			<!-- Empty state -->
			<div v-else class="flex flex-col items-center justify-center py-16 text-center px-6">
				<div class="p-4 rounded-full bg-bg-surface mb-4">
					<Icon name="lucide:scroll-text" class="w-8 h-8 text-text-tertiary" />
				</div>
				<p class="text-text-secondary font-medium">No delivery logs yet</p>
				<p class="text-sm text-text-tertiary mt-1">Send a test webhook to see delivery logs here.</p>
				<button
					class="btn btn-primary gap-2 mt-4"
					:disabled="isSendingTest"
					@click="emit('sendTest')"
				>
					<Icon v-if="isSendingTest" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
					<Icon v-else name="lucide:send" class="w-4 h-4" />
					{{ isSendingTest ? 'Sending...' : 'Send Test Webhook' }}
				</button>
			</div>
		</div>
	</UiModal>
</template>
