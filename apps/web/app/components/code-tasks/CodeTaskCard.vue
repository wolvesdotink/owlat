<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	task: {
		_id: Id<'codeWorkTasks'>;
		description: string;
		status: 'queued' | 'running' | 'testing' | 'review' | 'merged' | 'failed';
		branch?: string;
		prUrl?: string;
		testResults?: string;
		errorMessage?: string;
		llmCost?: number;
		createdAt: number;
		updatedAt: number;
	};
}>();

const { run: cancelMutation } = useBackendOperation(api.codeWorkTasks.cancel, {
	label: 'Cancel task',
});
const isCancelling = ref(false);

const canCancel = computed(() =>
	props.task.status === 'queued' || props.task.status === 'running',
);

const handleCancel = async () => {
	isCancelling.value = true;
	await cancelMutation({ taskId: props.task._id });
	isCancelling.value = false;
};

const formatCost = (cost: number) => {
	return `$${cost.toFixed(4)}`;
};
</script>

<template>
	<div class="card">
		<!-- Header: description + status -->
		<div class="flex items-start justify-between gap-3 mb-3">
			<p class="text-sm font-medium text-text-primary leading-snug flex-1">
				{{ task.description }}
			</p>
			<CodeTasksCodeTaskStatusBadge :status="task.status" />
		</div>

		<!-- Metadata -->
		<div class="space-y-2">
			<!-- Branch -->
			<div v-if="task.branch" class="flex items-center gap-2 text-xs text-text-secondary">
				<Icon name="lucide:git-branch" class="w-3.5 h-3.5 text-text-tertiary" />
				<code class="px-1.5 py-0.5 bg-bg-surface rounded text-text-primary font-mono text-[11px]">
					{{ task.branch }}
				</code>
			</div>

			<!-- PR link -->
			<div v-if="task.prUrl" class="flex items-center gap-2 text-xs">
				<Icon name="lucide:git-pull-request" class="w-3.5 h-3.5 text-text-tertiary" />
				<a
					:href="task.prUrl"
					target="_blank"
					rel="noopener noreferrer"
					class="text-brand hover:underline truncate"
				>
					{{ task.prUrl }}
				</a>
			</div>

			<!-- Test results -->
			<div v-if="task.testResults" class="flex items-start gap-2 text-xs text-text-secondary">
				<Icon name="lucide:flask-conical" class="w-3.5 h-3.5 text-text-tertiary mt-0.5" />
				<span class="whitespace-pre-wrap">{{ task.testResults }}</span>
			</div>

			<!-- Error message -->
			<div v-if="task.errorMessage && task.status === 'failed'" class="flex items-start gap-2 text-xs">
				<Icon name="lucide:alert-circle" class="w-3.5 h-3.5 text-error mt-0.5" />
				<span class="text-error whitespace-pre-wrap">{{ task.errorMessage }}</span>
			</div>
		</div>

		<!-- Footer: cost, time, cancel -->
		<div class="flex items-center justify-between mt-4 pt-3 border-t border-border-subtle">
			<div class="flex items-center gap-3 text-xs text-text-tertiary">
				<span>{{ formatCompactRelativeTime(task.createdAt) }}</span>
				<span v-if="task.llmCost != null" class="flex items-center gap-1">
					<Icon name="lucide:coins" class="w-3 h-3" />
					{{ formatCost(task.llmCost) }}
				</span>
			</div>

			<button
				v-if="canCancel"
				class="btn btn-ghost btn-sm gap-1 text-error hover:bg-error-subtle"
				:disabled="isCancelling"
				@click="handleCancel"
			>
				<Icon name="lucide:x" class="w-3 h-3" />
				{{ isCancelling ? 'Cancelling...' : 'Cancel' }}
			</button>
		</div>
	</div>
</template>
