<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import {
	marketingTemplatePresets,
	getPresetById,
	type TemplatePreset,
} from '~/data/marketingTemplatePresets';

interface Props {
	open: boolean;
}

interface Emits {
	(e: 'update:open', value: boolean): void;
	(e: 'create', templateId: Id<'emailTemplates'>): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

// Modal step state
const step = ref<'library' | 'customize'>('library');
const selectedPreset = ref<string | null>(null);
const previewPreset = ref<string | null>(null);

// Form state
const templateName = ref('');
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
	previewPreset.value = null;
	templateName.value = '';
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
		templateName.value = preset.name === 'Start from Blank' ? '' : preset.name;
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
	}) => Promise<Id<'emailTemplates'> | undefined>,
	createFromPreset: (args: {
		name: string;
		subject: string;
		content: string;
		type: 'marketing' | 'transactional';
	}) => Promise<Id<'emailTemplates'> | undefined>
) => {
	if (!templateName.value.trim()) {
		error.value = 'Template name is required';
		return;
	}

	isCreating.value = true;
	error.value = '';

	try {
		let templateId: Id<'emailTemplates'> | undefined;
		const preset = selectedPreset.value ? getPresetById(selectedPreset.value) : null;

		if (preset && preset.id !== 'blank') {
			templateId = await createFromPreset({
				name: templateName.value.trim(),
				subject: preset.subject,
				content: JSON.stringify(preset.content),
				type: 'marketing',
			});
		} else {
			templateId = await createTemplate({
				name: templateName.value.trim(),
				type: 'marketing',
			});
		}

		if (!templateId) {
			throw new Error('Failed to create template');
		}

		emit('create', templateId);
		close();
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to create template';
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
		:title="step === 'library' ? 'Choose a Template' : 'Customize Your Template'"
		size="4xl"
		:closable="!isCreating"
		:persistent="isCreating"
		@update:open="(v) => { if (!v) close(); }"
	>
		<!-- Back navigation (relocated from header — UiModal renders the title row) -->
		<button
			v-if="step === 'customize'"
			class="flex items-center gap-2 mb-4 p-1 -ml-1 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
			@click="goBackToLibrary"
		>
			<Icon name="lucide:arrow-left" class="w-5 h-5" />
			<span class="text-sm">Back to templates</span>
		</button>

		<!-- Content -->
		<div class="-mx-6 -mb-6 max-h-[70vh] overflow-y-auto">
			<!-- Step 1: Template Library -->
			<div v-if="step === 'library'" class="p-6">
							<p class="text-text-secondary mb-6">
								Start with a template to speed up your workflow, or begin from scratch.
							</p>

							<div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
								<div
									v-for="preset in marketingTemplatePresets"
									:key="preset.id"
									class="group relative"
									@mouseenter="previewPreset = preset.id"
									@mouseleave="previewPreset = null"
								>
									<button
										:class="[
											'w-full text-left rounded-xl border transition-all overflow-hidden',
											preset.id === 'blank'
												? 'border-dashed border-border-default hover:border-brand'
												: 'border-border-subtle hover:border-brand hover:shadow-lg',
										]"
										@click="selectPreset(preset.id)"
									>
										<!-- Preview Thumbnail -->
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
												<Icon name="lucide:plus" class="w-8 h-8 mb-2" />
												<span class="text-sm">Empty Canvas</span>
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
												<Icon :name="preset.icon" class="w-4 h-4 text-brand shrink-0" />
												<h3 class="font-medium text-text-primary text-sm truncate">
													{{ preset.name }}
												</h3>
											</div>
											<p class="text-xs text-text-tertiary mt-1 truncate">
												{{ preset.description }}
											</p>
										</div>
									</button>

									<!-- Preview Button -->
									<button
										v-if="preset.id !== 'blank'"
										class="absolute top-2 right-2 p-2 rounded-lg bg-bg-deep/80 text-text-primary opacity-0 group-hover:opacity-100 transition-opacity hover:bg-bg-deep"
										@click.stop="previewPreset = previewPreset === preset.id ? null : preset.id"
									 aria-label="Preview">
										<Icon name="lucide:eye" class="w-4 h-4" />
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
								<h3 class="text-sm font-medium text-text-secondary mb-3">Preview</h3>
								<div class="bg-white rounded-lg shadow-sm overflow-hidden">
									<div
										v-if="selectedPresetData"
										class="p-4"
										v-html="selectedPresetData.previewHtml"
									/>
									<div v-else class="p-8 text-center text-text-tertiary">
										<p class="text-sm">Empty template</p>
									</div>
								</div>
							</div>

							<!-- Form -->
							<div class="lg:w-1/2 p-6">
								<form @submit.prevent>
									<!-- Error -->
									<div
										v-if="error"
										class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 flex items-start gap-3"
									>
										<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
										<p class="text-sm text-error">{{ error }}</p>
									</div>

									<!-- Selected Template Info -->
									<div
										v-if="selectedPresetData"
										class="mb-4 p-3 rounded-lg bg-brand/10 border border-brand/20"
									>
										<div class="flex items-center gap-2">
											<Icon :name="selectedPresetData.icon" class="w-4 h-4 text-brand" />
											<span class="text-sm font-medium text-text-primary">
												{{ selectedPresetData.name }}
											</span>
										</div>
									</div>

									<!-- Name Field -->
									<UiInput
										id="template-name"
										v-model="templateName"
										label="Template Name"
										required
										placeholder="e.g., Weekly Newsletter"
										:disabled="isCreating"
										class="mb-6"
									/>

									<!-- Actions -->
									<div class="flex justify-end gap-3">
										<UiButton variant="secondary" :disabled="isCreating" @click="goBackToLibrary">
											Back
										</UiButton>
										<slot name="submit-button" :is-creating="isCreating" />
									</div>
								</form>
							</div>
						</div>
					</div>
	</UiModal>
</template>
