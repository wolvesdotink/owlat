<script setup lang="ts">
/**
 * The "New transactional email" dialog: name, slug (derived from the name until
 * edited) and default language. On success it opens the new email's editor.
 */
import { api } from '@owlat/api';
import { toSlug } from '@owlat/shared';
import { languageOptions, formatLanguageLabel } from '~/data/languageOptions';

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
	>
		<form @submit.prevent="handleCreate">
			<div
				v-if="createError"
				class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 flex items-start gap-3"
			>
				<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
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
				class="mb-4 font-mono"
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

		<template #footer>
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
