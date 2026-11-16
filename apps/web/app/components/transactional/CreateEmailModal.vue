<script setup lang="ts">
/**
 * The "New transactional email" dialog: name, slug (derived from the name until
 * edited) and default language. On success it opens the new email's editor.
 * When AI drafting is on, "Draft with AI" writes the email from a sentence
 * instead; name and slug are then suggested unless typed, and stay editable in
 * the editor.
 */
import { api } from '@owlat/api';
import { toSlug } from '@owlat/shared';
import { languageOptions, formatLanguageLabel } from '~/data/languageOptions';
import { generationEntry, warmEmailGeneratePanel } from '~/lib/emailGenerationEntry';
import { useEmailGenerationInFlight } from '~/composables/useEmailGenerationInFlight';
import type { GenerationResult } from '~/composables/useEmailGeneration';
import { CircleWarningIcon, SparklesIcon } from '@coolicons/vue';

const open = defineModel<boolean>('open', { required: true });

const { t } = useI18n();
const router = useRouter();

const createError = ref<string | null>('');
const { run: createEmail } = useBackendOperation(api.transactional.emails.create, {
	label: () => t('dashboard.send.transactional.index.create.operation'),
	inlineTarget: createError,
});

// `defaultLanguage` is captured at create time because a brand-new email has no
// translations yet — there is nothing to re-key — so a plain field on
// `create` is correct (the content-swapping `setDefaultLanguage` path that
// marketing needs only applies once overlays exist). Without this the backend
// default of 'en' was unavoidable for any dashboard-authored email.
const form = reactive({ name: '', slug: '', defaultLanguage: 'en' });
const errors = reactive({ name: '', slug: '' });
const isCreating = ref(false);

const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const { can } = usePermissions();
const aiEntry = computed(() => generationEntry('transactional', { isFeatureEnabled, can }));
const isAiDraftInFlight = useEmailGenerationInFlight('transactional');
const mode = ref<'blank' | 'ai'>('blank');
/** AI mode: '' writes in the language of the description. */
const aiLanguage = ref('');
const modeOptions = computed(() => [
	{ value: 'blank', label: t('components.ai.emailGenerate.mode.blank') },
	{ value: 'ai', label: t('components.ai.emailGenerate.mode.ai') },
]);
const aiLanguageOptions = computed(() => [
	{ value: '', label: t('components.ai.emailGenerate.languageFromPrompt') },
	...languageSelectOptions.value,
]);

const handleGenerated = (result: GenerationResult) => {
	if (result.kind !== 'transactional') return;
	open.value = false;
	router.push(`/dashboard/send/transactional/${result.transactionalEmailId}/edit`);
};

watch(
	() => form.name,
	(name) => {
		if (!form.slug || form.slug === toSlug(form.name.slice(0, -1))) {
			form.slug = toSlug(name);
		}
	}
);

// Every open starts from a blank form.
watch(open, (isOpen) => {
	if (!isOpen) return;
	form.name = '';
	form.slug = '';
	form.defaultLanguage = 'en';
	errors.name = '';
	errors.slug = '';
	createError.value = '';
	// A draft still being written reopens on its progress.
	mode.value = isAiDraftInFlight.value ? 'ai' : 'blank';
});

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const languageSelectOptions = computed(() =>
	languageOptions.map((l) => ({
		value: l.value,
		label: formatLanguageLabel({ label: t(l.label), nativeLabel: l.nativeLabel }),
	}))
);

const handleCreate = async () => {
	errors.name = '';
	errors.slug = '';
	createError.value = '';

	if (!form.name.trim()) errors.name = t('dashboard.send.transactional.index.create.nameRequired');
	if (!form.slug.trim()) errors.slug = t('dashboard.send.transactional.index.create.slugRequired');
	else if (!SLUG_PATTERN.test(form.slug))
		errors.slug = t('dashboard.send.transactional.index.create.slugInvalid');
	if (errors.name || errors.slug) return;

	isCreating.value = true;
	const created = await createEmail({
		name: form.name.trim(),
		slug: form.slug.trim(),
		defaultLanguage: form.defaultLanguage,
	});
	isCreating.value = false;
	if (!created.ok) return;

	open.value = false;
	router.push(`/dashboard/send/transactional/${created.result}/edit`);
};
</script>

<template>
	<UiModal
		v-model:open="open"
		:title="t('dashboard.send.transactional.index.create.title')"
		:persistent="isCreating"
		:size="mode === 'ai' ? '2xl' : 'md'"
	>
		<UiSegmentedControl
			v-if="aiEntry === 'show'"
			v-model="mode"
			:options="modeOptions"
			class="mb-5"
			data-testid="transactional-create-mode"
			@pointerenter="warmEmailGeneratePanel"
			@focusin="warmEmailGeneratePanel"
		/>
		<p
			v-else-if="aiEntry === 'enable_hint'"
			class="mb-4 flex items-center gap-2 text-sm text-text-tertiary"
		>
			<SparklesIcon class="h-4 w-4 shrink-0" aria-hidden="true" />
			<span>
				{{ t('components.ai.emailGenerate.enableHint') }}
				<NuxtLink to="/dashboard/admin/instance/features" class="text-brand hover:underline">
					{{ t('components.ai.emailGenerate.openFeatures') }}
				</NuxtLink>
			</span>
		</p>

		<div v-if="mode === 'ai' && aiEntry === 'show'" class="space-y-5">
			<UiSelect
				v-model="aiLanguage"
				:label="t('components.ai.emailGenerate.languageLabel')"
				:options="aiLanguageOptions"
			/>
			<AiEmailGenerateLoader
				kind="transactional"
				:default-language="aiLanguage || undefined"
				@created="handleGenerated"
			>
				<template #secondary>
					<UiButton variant="secondary" @click="open = false">{{ t('common.cancel') }}</UiButton>
				</template>
			</AiEmailGenerateLoader>
		</div>

		<form v-else @submit.prevent="handleCreate">
			<div
				v-if="createError"
				class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 flex items-start gap-3"
			>
				<CircleWarningIcon class="w-5 h-5 text-error shrink-0 mt-0.5" />
				<p class="text-sm text-error">{{ createError }}</p>
			</div>

			<UiInput
				id="email-name"
				v-model="form.name"
				:label="t('common.name')"
				required
				:placeholder="t('dashboard.send.transactional.index.create.namePlaceholder')"
				:error="errors.name"
				:disabled="isCreating"
				class="mb-4"
			/>

			<UiInput
				id="email-slug"
				v-model="form.slug"
				:label="t('dashboard.send.transactional.index.create.slugLabel')"
				required
				:placeholder="t('dashboard.send.transactional.index.create.slugPlaceholder')"
				:error="errors.slug"
				:help-text="
					!errors.slug ? t('dashboard.send.transactional.index.create.slugHelp') : undefined
				"
				:disabled="isCreating"
				class="mb-4 [&_input]:font-mono"
			/>

			<!-- Default Language — the language the body you author here is
			     treated as. A non-English deployment can author the template in
			     German and mark German as the default so language resolution and
			     the Translation Manager anchor to the right source. -->
			<UiSelect
				v-model="form.defaultLanguage"
				:label="t('dashboard.send.transactional.index.create.defaultLanguage')"
				:options="languageSelectOptions"
				:disabled="isCreating"
				class="mb-6"
			/>
		</form>

		<template v-if="mode === 'blank' || aiEntry !== 'show'" #footer>
			<UiButton variant="secondary" :disabled="isCreating" @click="open = false">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton :loading="isCreating" @click="handleCreate">
				{{
					isCreating
						? t('dashboard.send.transactional.index.create.creating')
						: t('dashboard.send.transactional.index.create.submit')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
