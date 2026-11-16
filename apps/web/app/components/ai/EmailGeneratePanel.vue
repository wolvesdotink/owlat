<script setup lang="ts">
/**
 * The AI email generator every entry point shares: the template library,
 * "New transactional email" and the new-campaign flow. One prompt, optional
 * references, the style switch, a sentence on what will be created, and the
 * run's honest states. The run itself lives in `useEmailGeneration`, so this
 * panel can close mid-run without losing or repeating the draft.
 */
import { BUDGET_REASON_KEYS } from '~/utils/aiBudget';
import type { BudgetHoldReason } from '@owlat/shared/aiRouting';
import {
	EXAMPLE_PROMPT_KEYS,
	FAILURE_KEYS,
	MAX_PROMPT_CHARS,
	type GenerationKind,
} from '~/lib/emailGeneration';
import { useEmailGeneration, type GenerationResult } from '~/composables/useEmailGeneration';
import { SparklesIcon } from '@coolicons/vue';

const props = defineProps<{
	kind: GenerationKind;
	/** The language to write in; absent, the language of the prompt. */
	defaultLanguage?: string;
}>();

const emit = defineEmits<{ created: [result: GenerationResult] }>();

const { t } = useI18n();
const { isAdmin } = usePermissions();
const { state, isGenerating, generate, attach, dismissFailure } = useEmailGeneration(props.kind);

const K = 'components.ai.emailGenerate';
const promptId = useId();
const styleId = useId();
const promptRef = ref<{ $el?: HTMLElement } | null>(null);

onMounted(async () => {
	const detach = attach((result) => emit('created', result));
	onBeforeUnmount(detach);
	await nextTick();
	promptRef.value?.$el?.querySelector('textarea')?.focus();
});

const canSubmit = computed(
	() =>
		!isGenerating.value &&
		state.value.prompt.trim().length > 0 &&
		state.value.prompt.length <= MAX_PROMPT_CHARS
);

function submit() {
	if (!canSubmit.value) return;
	void generate(props.defaultLanguage ? { defaultLanguage: props.defaultLanguage } : {});
}

function useExample(key: string) {
	state.value.prompt = t(`${key}.prompt`);
	dismissFailure();
}

const failureMessage = computed(() => {
	const failure = state.value.failure;
	if (!failure) return null;
	if (failure.kind === 'budget') {
		const reason = failure.reason as BudgetHoldReason | null;
		const detail = reason && reason in BUDGET_REASON_KEYS ? t(BUDGET_REASON_KEYS[reason]) : '';
		return `${t(FAILURE_KEYS.budget)} ${detail}`.trim();
	}
	if (failure.kind === 'invalid_input') return t(`${K}.errors.invalidInput`);
	return t(FAILURE_KEYS[failure.kind]);
});

/** An admin can fix a missing provider or a switched-off feature on the Features page. */
const showFeaturesLink = computed(
	() =>
		isAdmin.value &&
		(state.value.failure?.kind === 'not_configured' || state.value.failure?.kind === 'feature_off')
);

/** A pick the server could not find is removed, so the next try can go. */
watch(
	() => state.value.failure,
	(failure) => {
		if (failure?.kind === 'reference_missing' && failure.referenceId) {
			state.value.references = state.value.references.filter((r) => r.id !== failure.referenceId);
		}
	}
);
</script>

<template>
	<form class="space-y-5" data-testid="email-generate-panel" @submit.prevent="submit">
		<div>
			<UiTextarea
				:id="promptId"
				ref="promptRef"
				v-model="state.prompt"
				:label="t(`${K}.promptLabel`)"
				:placeholder="t(`${K}.promptPlaceholder.${kind}`)"
				:rows="4"
				:max-length="MAX_PROMPT_CHARS"
				:disabled="isGenerating"
				resize="vertical"
				@update:model-value="dismissFailure"
				@keydown.meta.enter.prevent="submit"
				@keydown.ctrl.enter.prevent="submit"
			/>
			<div class="mt-2 flex flex-wrap items-center gap-2">
				<span class="text-xs text-text-tertiary">{{ t(`${K}.examplesLabel`) }}</span>
				<button
					v-for="key in EXAMPLE_PROMPT_KEYS[kind]"
					:key="key"
					type="button"
					class="rounded-full border border-border-subtle px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-brand hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
					:disabled="isGenerating"
					@click="useExample(key)"
				>
					{{ t(`${key}.label`) }}
				</button>
			</div>
		</div>

		<div v-if="kind === 'transactional'" class="grid gap-4 sm:grid-cols-2">
			<UiInput
				v-model="state.name"
				:label="t('common.name')"
				:placeholder="t(`${K}.suggestedPlaceholder`)"
				:disabled="isGenerating"
			/>
			<UiInput
				v-model="state.slug"
				class="[&_input]:font-mono"
				:label="t('dashboard.send.transactional.index.create.slugLabel')"
				:placeholder="t(`${K}.suggestedPlaceholder`)"
				:disabled="isGenerating"
			/>
			<p class="text-xs text-text-tertiary sm:col-span-2 -mt-2">{{ t(`${K}.nameSlugHelp`) }}</p>
		</div>

		<AiEmailReferencePicker v-model="state.references" :disabled="isGenerating" />

		<div class="flex items-start justify-between gap-4">
			<div>
				<p :id="styleId" class="text-sm font-medium text-text-primary">{{ t(`${K}.matchStyle`) }}</p>
				<p class="text-xs text-text-tertiary">{{ t(`${K}.matchStyleHelp`) }}</p>
			</div>
			<UiSwitch
				v-model="state.matchStyle"
				:label="t(`${K}.matchStyle`)"
				:disabled="isGenerating"
			/>
		</div>

		<UiErrorAlert
			v-if="failureMessage"
			:message="failureMessage"
			role="alert"
			data-testid="email-generate-error"
		/>
		<p v-if="showFeaturesLink" class="-mt-3 text-sm">
			<NuxtLink to="/dashboard/admin/instance/features" class="text-brand hover:underline">
				{{ t(`${K}.openFeatures`) }}
			</NuxtLink>
		</p>

		<div
			v-if="isGenerating"
			class="flex items-center gap-3 rounded-lg border border-border-subtle bg-bg-surface p-3"
			role="status"
			aria-live="polite"
			data-testid="email-generate-progress"
		>
			<UiSpinner size="sm" />
			<div>
				<p class="text-sm font-medium text-text-primary">{{ t(`${K}.generating`) }}</p>
				<p class="text-xs text-text-tertiary">{{ t(`${K}.generatingHelp`) }}</p>
			</div>
		</div>
		<p v-else class="text-sm text-text-secondary">{{ t(`${K}.summary.${kind}`) }}</p>

		<div class="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
			<slot name="secondary" :is-generating="isGenerating" />
			<UiButton type="submit" class="gap-2" :disabled="!canSubmit" :loading="isGenerating">
				<SparklesIcon v-if="!isGenerating" class="h-4 w-4" aria-hidden="true" />
				{{ isGenerating ? t(`${K}.submitting`) : t(`${K}.submit`) }}
				<UiShortcut
					v-if="!isGenerating"
					chord="mod+Enter"
					class="ml-1 hidden rounded border border-current px-1 text-[11px] font-normal opacity-70 sm:inline"
				/>
			</UiButton>
		</div>
	</form>
</template>
