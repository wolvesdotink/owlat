<script setup lang="ts">
/**
 * "Rebuild with another model" (U1, ADR-0073 Phase 5): a staged rebuild fills
 * the second vector column with the new model while vector search keeps using
 * the active one, so a model change has no gap. Once the rebuild has walked
 * the corpus, validation samples rows and checks each finds itself in the new
 * space; activation validates again and switches search and the stored
 * configuration in one step. The space it replaced stays available for a
 * rollback while it still owns its column.
 *
 * A rebuild moves between local embedders, or between models of the stored
 * hosted provider, so no key changes hands; any other change is a settings
 * change (the switch path, with the coverage gap the card above explains). A
 * hosted rebuild is paid work through spend admission and says so first.
 */
import { computed, ref, watch } from 'vue';
import type { useEmbeddingSpaces } from '~/composables/useEmbeddingSpaces';
import {
	embeddingProviderMeta,
	modelOptions,
	resolveModelId,
	type EmbeddingProviderKind,
} from '~/utils/aiProviders';
import {
	hasOpenJob,
	jobStateKey,
	rebuildJob,
	rebuildKinds,
	type EmbeddingStatus,
} from '~/utils/embeddingSpaces';
import { formatNumber } from '~/utils/formatters';

const props = defineProps<{
	spaces: ReturnType<typeof useEmbeddingSpaces>;
	status: EmbeddingStatus;
}>();

const { t } = useI18n();
const K = 'dashboard.admin.instance.aiProvider.embeddingSpace.rebuild';

const kinds = computed(() => rebuildKinds(props.status));
const kindOptions = computed(() =>
	kinds.value.map((kind) => ({
		value: kind,
		label: t(embeddingProviderMeta(kind)?.label ?? kind),
	}))
);
const kind = ref<EmbeddingProviderKind>(kinds.value[0] ?? 'local');
watch(kinds, (next) => {
	if (!next.includes(kind.value) && next[0]) kind.value = next[0];
});
const meta = computed(() => embeddingProviderMeta(kind.value));
const modelChoice = ref(meta.value?.defaultModel ?? '');
const modelCustom = ref('');
watch(kind, () => {
	modelChoice.value = meta.value?.defaultModel ?? '';
	modelCustom.value = '';
});
const options = computed(() => modelOptions(meta.value?.curatedModels ?? [], modelChoice.value));
const model = computed(() => resolveModelId(modelChoice.value, modelCustom.value));

const isPaid = computed(() => meta.value?.isLocal === false);
const isSameAsActive = computed(
	() =>
		props.status.configured?.provider === kind.value &&
		props.status.configured?.model === model.value
);
const startBlocker = computed(() => {
	if (hasOpenJob(props.status.jobs)) return `${K}.blocked.jobOpen`;
	if (!model.value) return `${K}.blocked.noModel`;
	if (isSameAsActive.value) return `${K}.blocked.sameModel`;
	if (isPaid.value && !props.status.isPaidEmbeddingAvailable) return `${K}.blocked.paidUnavailable`;
	return null;
});

const confirmPaid = ref(false);
async function start() {
	if (startBlocker.value) return;
	if (isPaid.value && !confirmPaid.value) {
		confirmPaid.value = true;
		return;
	}
	const isStarted = await props.spaces.startRebuild({
		embeddingProviderKind: kind.value,
		embeddingModel: model.value,
	});
	if (isStarted) confirmPaid.value = false;
}

const staged = computed(() => props.status.staged);
const job = computed(() => rebuildJob(props.status));
const isJobOpen = computed(() => job.value?.status === 'running' || job.value?.status === 'paused');
const isFilled = computed(() => job.value?.status === 'completed');
const validation = computed(() =>
	props.spaces.validation.value?.spaceId === staged.value?._id
		? props.spaces.validation.value
		: null
);

const confirmRollback = ref(false);
async function rollback() {
	if (await props.spaces.rollback()) confirmRollback.value = false;
}

const isShown = computed(
	() => props.status.canStageRebuild || staged.value !== null || props.status.rollbackTo !== null
);
</script>

<template>
	<section v-if="isShown" data-testid="ai-embedding-rebuild">
		<h3 class="text-sm font-medium text-text-primary">{{ t(`${K}.title`) }}</h3>
		<p class="mt-1 text-xs text-text-tertiary">{{ t(`${K}.description`) }}</p>

		<div
			v-if="staged"
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
					type="button"
					variant="secondary"
					size="sm"
					:disabled="spaces.isBusy.value || !isFilled"
					@click="spaces.validate"
				>
					{{ t(`${K}.validate`) }}
				</UiButton>
				<UiButton
					type="button"
					size="sm"
					:disabled="spaces.isBusy.value || !isFilled"
					data-testid="ai-embedding-rebuild-activate"
					@click="spaces.activate"
				>
					{{ t(`${K}.activate`) }}
				</UiButton>
				<UiButton
					type="button"
					variant="ghost"
					size="sm"
					:disabled="spaces.isBusy.value || isJobOpen"
					@click="spaces.catchUp"
				>
					{{ t(`${K}.catchUp`) }}
				</UiButton>
				<UiButton
					type="button"
					variant="ghost"
					size="sm"
					:disabled="spaces.isBusy.value"
					@click="spaces.cancelRebuild"
				>
					{{ t(`${K}.cancel`) }}
				</UiButton>
			</div>
			<p class="text-xs text-text-tertiary">{{ t(`${K}.activateHint`) }}</p>
		</div>

		<div
			v-else-if="status.canStageRebuild"
			class="mt-3 space-y-4 rounded-lg border border-border-subtle p-4"
			data-testid="ai-embedding-rebuild-form"
		>
			<div class="grid gap-4 sm:grid-cols-2">
				<UiSelect
					v-model="kind"
					size="sm"
					:label="t(`${K}.providerLabel`)"
					:options="kindOptions"
					:disabled="spaces.isBusy.value || kindOptions.length < 2"
				/>
				<SettingsAiModelPicker
					v-model:choice="modelChoice"
					v-model:custom="modelCustom"
					:label="t(`${K}.modelLabel`)"
					:options="options"
					:disabled="spaces.isBusy.value"
				/>
			</div>
			<p class="text-xs text-text-tertiary">
				{{ t(isPaid ? `${K}.costHosted` : `${K}.costLocal`) }}
			</p>
			<div class="flex flex-wrap items-center gap-3">
				<UiButton
					type="button"
					variant="secondary"
					size="sm"
					:disabled="spaces.isBusy.value || startBlocker !== null"
					data-testid="ai-embedding-rebuild-start"
					@click="start"
				>
					{{ t(`${K}.start`) }}
				</UiButton>
				<p v-if="startBlocker" class="text-xs text-text-tertiary">{{ t(startBlocker) }}</p>
			</div>
		</div>

		<div
			v-if="status.rollbackTo && !staged"
			class="mt-3 flex flex-col gap-2 rounded-lg border border-border-subtle p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
			data-testid="ai-embedding-rollback"
		>
			<p class="text-text-secondary">
				{{ t(`${K}.rollbackAvailable`, { model: status.rollbackTo.model }) }}
			</p>
			<UiButton
				type="button"
				variant="ghost"
				size="sm"
				class="shrink-0"
				:disabled="spaces.isBusy.value"
				@click="confirmRollback = true"
			>
				{{ t(`${K}.rollback`) }}
			</UiButton>
		</div>

		<UiConfirmationDialog
			v-model:open="confirmPaid"
			:title="t(`${K}.confirmPaidTitle`)"
			:description="t(`${K}.confirmPaidBody`, { model })"
			:confirm-text="t(`${K}.start`)"
			:is-loading="spaces.isBusy.value"
			@confirm="start"
		/>
		<UiConfirmationDialog
			v-model:open="confirmRollback"
			:title="t(`${K}.rollbackTitle`, { model: status.rollbackTo?.model ?? '' })"
			:description="t(`${K}.rollbackBody`)"
			:confirm-text="t(`${K}.rollback`)"
			:is-loading="spaces.isBusy.value"
			@confirm="rollback"
		/>
	</section>
</template>
