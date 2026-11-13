<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import {
	marketingTemplatePresets,
	getPresetById,
	type TemplatePreset,
} from '~/data/marketingTemplatePresets';
import { PlusIcon } from '@coolicons/vue';

interface Props {
	open: boolean;
}

interface Emits {
	(e: 'update:open', value: boolean): void;
	(e: 'create', templateId: Id<'emailTemplates'>): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const { t } = useI18n();

// The preset catalog is a module-scope registry: its `name`/`description` are
// message keys, resolved here at render time.
const presetText = (value: string) => t(value);

// Modal step state
const step = ref<'library' | 'customize'>('library');
const selectedPreset = ref<string | null>(null);

// Form state
const templateName = ref('');
// The missing-name error belongs on the field; a failed create is not about it.
const nameError = ref('');
const error = ref('');
const isCreating = ref(false);

// Reset state when modal opens/closes
watch(
	() => props.open,
	(isOpen) => {
		if (isOpen) {
			resetState();
		}
	}
);

const resetState = () => {
	step.value = 'library';
	selectedPreset.value = null;
	templateName.value = '';
	nameError.value = '';
	error.value = '';
	isCreating.value = false;
};

const close = () => {
	if (!isCreating.value) {
		emit('update:open', false);
	}
};

const selectPreset = (presetId: string) => {
	selectedPreset.value = presetId;
	const preset = getPresetById(presetId);
	if (preset) {
		templateName.value = preset.id === 'blank' ? '' : presetText(preset.name);
	}
	step.value = 'customize';
};

const goBackToLibrary = () => {
	step.value = 'library';
	selectedPreset.value = null;
};

// Expose for parent component to call create
const handleCreate = async (
	createTemplate: (args: {
		name: string;
		type: 'marketing' | 'transactional';
	}) => Promise<BackendOperationResult<Id<'emailTemplates'>>>,
	createFromPreset: (args: {
		name: string;
		subject: string;
		content: string;
		type: 'marketing' | 'transactional';
	}) => Promise<BackendOperationResult<Id<'emailTemplates'>>>
) => {
	if (!templateName.value.trim()) {
		nameError.value = t('components.mail.templateLibraryModal.nameRequired');
		return;
	}

	isCreating.value = true;
	nameError.value = '';
	error.value = '';

	try {
		let created: BackendOperationResult<Id<'emailTemplates'>>;
		const preset = selectedPreset.value ? getPresetById(selectedPreset.value) : null;

		if (preset && preset.id !== 'blank') {
			created = await createFromPreset({
				name: templateName.value.trim(),
				subject: preset.subject,
				content: JSON.stringify(preset.content),
				type: 'marketing',
			});
		} else {
			created = await createTemplate({
				name: templateName.value.trim(),
				type: 'marketing',
			});
		}

		if (!created.ok) {
			throw new Error(t('components.mail.templateLibraryModal.createFailed'));
		}

		emit('create', created.result);
		close();
	} catch (err) {
		error.value =
			err instanceof Error ? err.message : t('components.mail.templateLibraryModal.createFailed');
	} finally {
		isCreating.value = false;
	}
};

const selectedPresetData = computed(() => {
	return selectedPreset.value ? getPresetById(selectedPreset.value) : null;
});

defineExpose({
	handleCreate,
	templateName,
	isCreating,
});
</script>

<template>
	<UiModal
		:open="open"
		:title="
			step === 'library'
				? t('components.mail.templateLibraryModal.libraryTitle')
				: t('components.mail.templateLibraryModal.customizeTitle')
		"
		size="4xl"
		:closable="!isCreating"
		:persistent="isCreating"
		@update:open="
			(v) => {
				if (!v) close();
			}
		"
	>
		<!-- One way back from the customize step: the footer's Back, next to Create. -->
		<!-- Content -->
		<div class="-mx-6 -mb-6 max-h-[70vh] overflow-y-auto">
			<!-- Step 1: Template Library -->
			<div v-if="step === 'library'" class="p-6">
				<p class="text-text-secondary mb-6">
					{{ t('components.mail.templateLibraryModal.intro') }}
				</p>

				<div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
					<!-- Choosing a card opens it in the customize step, beside its full
					     preview; there is no separate preview control. -->
					<div v-for="preset in marketingTemplatePresets" :key="preset.id" class="relative">
						<button
							type="button"
							:class="[
								'w-full text-left rounded-xl border transition-[border-color,box-shadow] overflow-hidden',
								preset.id === 'blank'
									? 'border-dashed border-border-default hover:border-brand'
									: 'border-border-subtle hover:border-brand hover:shadow-surface-3',
							]"
							@click="selectPreset(preset.id)"
						>
							<!-- Preview Thumbnail.
										     palette-ok: preset markup ships its own fixed light
										     palette, so the paper behind it is literally white in
										     both app themes; only the empty-canvas tile follows
										     the surface tokens. -->
							<div
								:class="[
									'aspect-[4/3] overflow-hidden',
									preset.id === 'blank' ? 'bg-bg-surface' : 'bg-white',
								]"
							>
								<div
									v-if="preset.id === 'blank'"
									class="w-full h-full flex flex-col items-center justify-center text-text-tertiary"
								>
									<PlusIcon class="w-8 h-8 mb-2" :stroke-width="1.5" />
									<span class="text-sm">{{
										t('components.mail.templateLibraryModal.emptyCanvas')
									}}</span>
								</div>
								<div
									v-else
									class="w-full h-full overflow-hidden transform scale-[0.5] origin-top-left"
									style="width: 200%; height: 200%"
									v-html="preset.previewHtml"
								/>
							</div>

							<!-- Info -->
							<div class="p-3 bg-bg-elevated border-t border-border-subtle">
								<div class="flex items-center gap-2">
									<component :is="preset.icon" class="w-4 h-4 text-brand shrink-0" />
									<h3 class="font-medium text-text-primary text-sm truncate">
										{{ presetText(preset.name) }}
									</h3>
								</div>
								<p class="text-xs text-text-tertiary mt-1 truncate">
									{{ presetText(preset.description) }}
								</p>
							</div>
						</button>
					</div>
				</div>
			</div>

			<!-- Step 2: Customize -->
			<div v-else-if="step === 'customize'" class="flex flex-col lg:flex-row">
				<!-- Preview -->
				<div
					class="lg:w-1/2 p-6 bg-bg-surface border-b lg:border-b-0 lg:border-r border-border-subtle"
				>
					<h3 class="text-sm font-medium text-text-secondary mb-3">{{ t('common.preview') }}</h3>
					<!-- palette-ok: email paper — white in both themes (see thumbnail note above). -->
					<div class="bg-white rounded-lg shadow-sm overflow-hidden">
						<div v-if="selectedPresetData" class="p-4" v-html="selectedPresetData.previewHtml" />
						<div v-else class="p-8 text-center text-text-tertiary">
							<p class="text-sm">{{ t('components.mail.templateLibraryModal.emptyTemplate') }}</p>
						</div>
					</div>
				</div>

				<!-- Form -->
				<div class="lg:w-1/2 p-6">
					<form @submit.prevent>
						<!-- Error -->
						<UiErrorAlert v-if="error" :message="error" role="alert" class="mb-4" />

						<!-- Selected Template Info -->
						<div
							v-if="selectedPresetData"
							class="mb-4 p-3 rounded-lg bg-brand/10 border border-brand/20"
						>
							<div class="flex items-center gap-2">
								<component :is="selectedPresetData.icon" class="w-4 h-4 text-brand" />
								<span class="text-sm font-medium text-text-primary">
									{{ presetText(selectedPresetData.name) }}
								</span>
							</div>
						</div>

						<!-- Name Field -->
						<UiInput
							id="template-name"
							v-model="templateName"
							:label="t('components.mail.templateLibraryModal.nameLabel')"
							required
							:placeholder="t('components.mail.templateLibraryModal.namePlaceholder')"
							:disabled="isCreating"
							:error="nameError"
							class="mb-6"
							@update:model-value="nameError = ''"
						/>

						<!-- Actions -->
						<div class="flex justify-end gap-3">
							<UiButton variant="secondary" :disabled="isCreating" @click="goBackToLibrary">
								{{ t('common.back') }}
							</UiButton>
							<slot name="submit-button" :is-creating="isCreating" />
						</div>
					</form>
				</div>
			</div>
		</div>
	</UiModal>
</template>
