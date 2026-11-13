<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	CircleWarningIcon,
	CloseIcon,
	CoinsIcon,
	FlaskIcon,
	GitBranchIcon,
	GitPullRequestIcon,
} from '@coolicons/vue';

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

const { t, locale } = useI18n();

const { run: cancelMutation } = useBackendOperation(api.codeWorkTasks.cancel, {
	label: () => t('components.codeTasks.codeTaskCard.cancelOperation'),
});
const isCancelling = ref(false);

const canCancel = computed(() => props.task.status === 'queued' || props.task.status === 'running');

// Stopping a queued or running task cannot be taken back, so it asks first.
const showCancelConfirm = ref(false);
const handleCancel = async () => {
	isCancelling.value = true;
	try {
		const result = await cancelMutation({ taskId: props.task._id });
		if (result.ok) showCancelConfirm.value = false;
	} finally {
		isCancelling.value = false;
	}
};

const formatCost = (cost: number) =>
	new Intl.NumberFormat(locale.value, {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 4,
		maximumFractionDigits: 4,
	}).format(cost);
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
				<GitBranchIcon class="w-3.5 h-3.5 text-text-tertiary" />
				<code class="px-1.5 py-0.5 bg-bg-surface rounded text-text-primary font-mono text-2xs">
					{{ task.branch }}
				</code>
			</div>

			<!-- PR link -->
			<div v-if="task.prUrl" class="flex items-center gap-2 text-xs">
				<GitPullRequestIcon class="w-3.5 h-3.5 text-text-tertiary" />
				<!-- native-title: the full address of a pull request link truncated to the card -->
				<a
					:href="task.prUrl"
					target="_blank"
					rel="noopener noreferrer"
					class="text-brand hover:underline truncate"
					:title="task.prUrl"
				>
					{{ task.prUrl }}
				</a>
			</div>

			<!-- Test results -->
			<div v-if="task.testResults" class="flex items-start gap-2 text-xs text-text-secondary">
				<FlaskIcon class="w-3.5 h-3.5 text-text-tertiary mt-0.5" />
				<span class="whitespace-pre-wrap">{{ task.testResults }}</span>
			</div>

			<!-- Error message -->
			<div
				v-if="task.errorMessage && task.status === 'failed'"
				class="flex items-start gap-2 text-xs"
			>
				<CircleWarningIcon class="w-3.5 h-3.5 text-error mt-0.5" />
				<span class="text-error whitespace-pre-wrap">{{ task.errorMessage }}</span>
			</div>
		</div>

		<!-- Footer: cost, time, cancel -->
		<div class="flex items-center justify-between mt-4 pt-3 border-t border-border-subtle">
			<div class="flex items-center gap-3 text-xs text-text-tertiary">
				<span>{{ formatCompactRelativeTime(task.createdAt) }}</span>
				<span v-if="task.llmCost != null" class="flex items-center gap-1">
					<CoinsIcon class="w-3 h-3" />
					{{ formatCost(task.llmCost) }}
				</span>
			</div>

			<UiButton
				v-if="canCancel"
				variant="danger-ghost"
				size="sm"
				class="gap-1"
				:disabled="isCancelling"
				@click="showCancelConfirm = true"
			>
				<CloseIcon class="w-3 h-3" aria-hidden="true" />
				{{ isCancelling ? t('components.codeTasks.codeTaskCard.cancelling') : t('common.cancel') }}
			</UiButton>
		</div>

		<UiConfirmationDialog
			:open="showCancelConfirm"
			variant="danger"
			:title="t('components.codeTasks.codeTaskCard.cancelOperation')"
			:description="t('components.codeTasks.codeTaskCard.cancelConfirmBody')"
			:confirm-text="t('components.codeTasks.codeTaskCard.cancelOperation')"
			:cancel-text="t('components.codeTasks.codeTaskCard.keepRunning')"
			:is-loading="isCancelling"
			@update:open="showCancelConfirm = $event"
			@confirm="handleCancel"
		/>
	</div>
</template>
