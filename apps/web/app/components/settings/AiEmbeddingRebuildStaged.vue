<script setup lang="ts">
/**
 * A staged rebuild in progress: its job, the last
 * validation, and the controls that finish or abandon it.
 *
 * Every control that embeds is gated on what the server says it costs: the
 * staged space's rebuild job carries `isPaid` (derived from the space's
 * endpoint), and without a job to tell, the work counts as paid. Paid work
 * waits for spend admission (`isPaidEmbeddingAvailable`) and is confirmed
 * first:
 *   - Validate and Activate embed a few sample items with the staged model;
 *   - Embed changes starts another pass over the corpus;
 *   - Resume continues a paused pass (its own job's `isPaid`).
 * Cancelling retires the staged space for good, so it is always confirmed.
 */
import { computed } from 'vue';
import type { useEmbeddingSpaces } from '~/composables/useEmbeddingSpaces';
import { useEmbeddingConfirm } from '~/composables/useEmbeddingConfirm';
import {
	jobPayment,
	jobStateKey,
	pausedJobKey,
	rebuildJob,
	resumeBlocker,
	stagedActionBlocker,
	stagedKey,
	stagedPayment,
	type StagedAction,
	type EmbeddingSpaceView,
	type EmbeddingStatus,
} from '~/utils/embeddingSpaces';
import { formatNumber } from '~/utils/formatters';

const props = defineProps<{
	spaces: ReturnType<typeof useEmbeddingSpaces>;
	status: EmbeddingStatus;
	staged: EmbeddingSpaceView;
}>();

const { t } = useI18n();
const K = 'dashboard.admin.instance.aiProvider.embeddingSpace.rebuild';

const job = computed(() => rebuildJob(props.status));
const isPaused = computed(() => job.value?.status === 'paused');
const validation = computed(() =>
	props.spaces.validation.value?.spaceId === props.staged._id ? props.spaces.validation.value : null
);

const isPaid = computed(() => stagedPayment(props.status) === 'paid');
// The live read, not the prop: a prop catches up only on the next render.
const live = () => props.spaces.status.value ?? null;
/** Each action's own prerequisites, against the live status. */
const actionBlocker = (action: StagedAction) => {
	const status = live();
	return status ? stagedActionBlocker(status, action) : null;
};
const validateBlock = computed(() => actionBlocker('validate'));
const activateBlock = computed(() => actionBlocker('activate'));
const catchUpBlock = computed(() => actionBlocker('catchUp'));
const resumeBlock = computed(() => (job.value ? resumeBlocker(props.status, job.value) : null));
/** The line under the buttons: why the next step cannot happen yet. */
const blocker = computed(() =>
	isPaused.value ? resumeBlock.value : (activateBlock.value ?? catchUpBlock.value)
);

const confirmation = useEmbeddingConfirm();
const model = () => props.staged.model;
/**
 * Every staged action names THIS staged space; the endpoints act on whatever
 * is staged when they run, so the confirmation is bound to it and lapses if
 * another admin replaces or cancels it meanwhile.
 */
const onStaged = (action: StagedAction) => ({
	targetKey: stagedKey(props.status) ?? '',
	currentKey: () => stagedKey(live()),
	blocker: () => actionBlocker(action),
});

function validate() {
	const spaceId = props.staged._id;
	void confirmation.ask(isPaid.value, {
		title: t(`${K}.confirmPaidTitle`),
		body: t(`${K}.paidValidateBody`, { model: model() }),
		confirmText: t(`${K}.validate`),
		...onStaged('validate'),
		run: () => props.spaces.validate(spaceId),
	});
}
function activate() {
	const spaceId = props.staged._id;
	void confirmation.ask(isPaid.value, {
		title: t(`${K}.confirmPaidTitle`),
		body: t(`${K}.paidActivateBody`, { model: model() }),
		confirmText: t(`${K}.activate`),
		...onStaged('activate'),
		run: () => props.spaces.activate(spaceId),
	});
}
function catchUp() {
	const spaceId = props.staged._id;
	void confirmation.ask(isPaid.value, {
		title: t(`${K}.confirmPaidTitle`),
		body: t(`${K}.paidCatchUpBody`, { model: model() }),
		confirmText: t(`${K}.catchUp`),
		...onStaged('catchUp'),
		run: () => props.spaces.catchUp(spaceId),
	});
}
function resume() {
	const paused = job.value;
	if (!paused) return;
	void confirmation.ask(jobPayment(paused) === 'paid', {
		title: t(`${K}.confirmPaidTitle`),
		body: t(`${K}.paidResumeBody`, { model: model() }),
		confirmText: t(`${K}.resume`),
		targetKey: pausedJobKey(props.status, paused._id) ?? '',
		currentKey: () => pausedJobKey(live(), paused._id),
		blocker: () => {
			const status = live();
			return status ? resumeBlocker(status, paused) : null;
		},
		run: () => props.spaces.resume(paused),
	});
}
function cancel() {
	const spaceId = props.staged._id;
	void confirmation.ask(true, {
		title: t(`${K}.cancelTitle`),
		body: t(`${K}.cancelBody`, { model: model() }),
		confirmText: t(`${K}.cancel`),
		isDanger: true,
		targetKey: stagedKey(props.status) ?? '',
		currentKey: () => stagedKey(live()),
		run: () => props.spaces.cancelRebuild(spaceId),
	});
}
</script>

<template>
	<div
		class="mt-3 space-y-3 rounded-lg border border-border-subtle p-4 text-sm"
		data-testid="ai-embedding-rebuild-staged"
	>
		<p class="text-text-primary font-medium">
			{{ t(`${K}.staged`, { model: staged.model, dimensions: staged.dimensions }) }}
		</p>
		<p v-if="job" class="text-text-secondary" :data-status="job.status">
			{{ t(jobStateKey(job)) }} ·
			{{
				t(`${K}.progress`, {
					embedded: formatNumber(job.embeddedCount),
					scanned: formatNumber(job.scannedCount),
				})
			}}
		</p>
		<p
			v-if="validation"
			:class="validation.isPassing ? 'text-success' : 'text-error'"
			role="status"
			data-testid="ai-embedding-rebuild-validation"
		>
			{{
				t(validation.isPassing ? `${K}.validation.passed` : `${K}.validation.failed`, {
					passed: validation.passed,
					sampled: validation.sampled,
				})
			}}
		</p>
		<div class="flex flex-wrap gap-2">
			<UiButton
				v-if="isPaused"
				type="button"
				variant="secondary"
				size="sm"
				:disabled="spaces.isBusy.value || resumeBlock !== null"
				data-testid="ai-embedding-rebuild-resume"
				@click="resume"
			>
				{{ t(`${K}.resume`) }}
			</UiButton>
			<UiButton
				type="button"
				variant="secondary"
				size="sm"
				:disabled="spaces.isBusy.value || validateBlock !== null"
				data-testid="ai-embedding-rebuild-validate"
				@click="validate"
			>
				{{ t(`${K}.validate`) }}
			</UiButton>
			<UiButton
				type="button"
				size="sm"
				:disabled="spaces.isBusy.value || activateBlock !== null"
				data-testid="ai-embedding-rebuild-activate"
				@click="activate"
			>
				{{ t(`${K}.activate`) }}
			</UiButton>
			<UiButton
				type="button"
				variant="ghost"
				size="sm"
				:disabled="spaces.isBusy.value || catchUpBlock !== null"
				data-testid="ai-embedding-rebuild-catch-up"
				@click="catchUp"
			>
				{{ t(`${K}.catchUp`) }}
			</UiButton>
			<UiButton
				type="button"
				variant="ghost"
				size="sm"
				:disabled="spaces.isBusy.value"
				data-testid="ai-embedding-rebuild-cancel"
				@click="cancel"
			>
				{{ t(`${K}.cancel`) }}
			</UiButton>
		</div>
		<p v-if="blocker" class="text-xs text-text-tertiary" data-testid="ai-embedding-rebuild-blocker">
			{{ t(blocker) }}
		</p>
		<p class="text-xs text-text-tertiary">{{ t(`${K}.activateHint`) }}</p>

		<UiConfirmationDialog
			:open="confirmation.pending.value !== null"
			:variant="confirmation.pending.value?.isDanger ? 'danger' : 'default'"
			:title="confirmation.pending.value?.title"
			:description="confirmation.pending.value?.body"
			:confirm-text="confirmation.pending.value?.confirmText"
			:is-loading="spaces.isBusy.value"
			@update:open="confirmation.dismiss"
			@confirm="confirmation.confirm"
		/>
	</div>
</template>
