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
 * rebuild whose endpoint the server does not report as local is paid work
 * through spend admission and says so first. The staged state is
 * `AiEmbeddingRebuildStaged`.
 */
import { computed, ref, watch } from 'vue';
import type { useEmbeddingSpaces } from '~/composables/useEmbeddingSpaces';
import { useEmbeddingConfirm } from '~/composables/useEmbeddingConfirm';
import {
	embeddingProviderMeta,
	modelOptions,
	resolveModelId,
	type EmbeddingProviderKind,
} from '~/utils/aiProviders';
import {
	configuredKey,
	hasOpenJob,
	paidBlocker,
	rebuildKinds,
	rebuildTargetPayment,
	rollbackKey,
	type EmbeddingStatus,
} from '~/utils/embeddingSpaces';

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

/**
 * Free only where the server reported the endpoint local (the configured
 * kind); another kind's endpoint is not exposed, so it counts as paid, and
 * the cost line says why instead of claiming either.
 */
const payment = computed(() => rebuildTargetPayment(props.status, kind.value));
const costKey = computed(() => {
	if (payment.value === 'free') return `${K}.costLocal`;
	const configured = props.status.configured;
	const isKnownHosted =
		meta.value?.isLocal === false ||
		(configured?.provider === kind.value && configured.isLocal === false);
	return isKnownHosted ? `${K}.costHosted` : `${K}.costUnknown`;
});
/** Why a rebuild cannot start against `status`; read live again at Confirm. */
function startBlockerOf(status: EmbeddingStatus | null): string | null {
	if (!status) return null;
	if (hasOpenJob(status.jobs) || status.staged) return `${K}.blocked.jobOpen`;
	if (!model.value) return `${K}.blocked.noModel`;
	if (status.configured?.provider === kind.value && status.configured.model === model.value) {
		return `${K}.blocked.sameModel`;
	}
	return paidBlocker(status, rebuildTargetPayment(status, kind.value));
}
const startBlocker = computed(() => startBlockerOf(props.status));

const confirmation = useEmbeddingConfirm();
// The live read, not the prop: a prop catches up only on the next render.
const live = () => props.spaces.status.value ?? null;
function start() {
	if (startBlocker.value) return;
	const target = { embeddingProviderKind: kind.value, embeddingModel: model.value };
	void confirmation.ask(payment.value === 'paid', {
		title: t(`${K}.confirmPaidTitle`),
		body: t(`${K}.confirmPaidBody`, { model: model.value }),
		confirmText: t(`${K}.start`),
		// Bound to the configuration the form was filled against.
		targetKey: configuredKey(props.status) ?? '',
		currentKey: () => configuredKey(live()),
		blocker: () => startBlockerOf(live()),
		run: () => props.spaces.startRebuild(target),
	});
}

/**
 * Rolling back is free and instant; what follows is not the same everywhere.
 * With the configured kind on a local endpoint (the server's locality), items
 * added since are re-embedded on their own; otherwise they wait for a re-embed
 * an admin starts, which a hosted embedder charges for.
 */
function rollback() {
	const target = props.status.rollbackTo;
	if (!target) return;
	const isLocalRecovery =
		props.status.configured?.isLocal === true &&
		props.status.configured.provider === target.provider;
	void confirmation.ask(true, {
		title: t(`${K}.rollbackTitle`, { model: target.model }),
		body: t(isLocalRecovery ? `${K}.rollbackBodyLocal` : `${K}.rollbackBodyHosted`),
		confirmText: t(`${K}.rollback`),
		targetKey: rollbackKey(props.status) ?? '',
		currentKey: () => rollbackKey(live()),
		run: props.spaces.rollback,
	});
}

const staged = computed(() => props.status.staged);
const isShown = computed(
	() => props.status.canStageRebuild || staged.value !== null || props.status.rollbackTo !== null
);
</script>

<template>
	<section v-if="isShown" data-testid="ai-embedding-rebuild">
		<h3 class="text-sm font-medium text-text-primary">{{ t(`${K}.title`) }}</h3>
		<p class="mt-1 text-xs text-text-tertiary">{{ t(`${K}.description`) }}</p>

		<SettingsAiEmbeddingRebuildStaged
			v-if="staged"
			:spaces="spaces"
			:status="status"
			:staged="staged"
		/>

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
				{{ t(costKey) }}
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
				@click="rollback"
			>
				{{ t(`${K}.rollback`) }}
			</UiButton>
		</div>

		<UiConfirmationDialog
			:open="confirmation.pending.value !== null"
			:title="confirmation.pending.value?.title"
			:description="confirmation.pending.value?.body"
			:confirm-text="confirmation.pending.value?.confirmText"
			:is-loading="spaces.isBusy.value"
			@update:open="confirmation.dismiss"
			@confirm="confirmation.confirm"
		/>
	</section>
</template>
