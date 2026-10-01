<script setup lang="ts">
import { api } from '@owlat/api';
import type { Doc, Id } from '@owlat/api/dataModel';

type EmailSelectionType = 'existing' | 'new';

interface Props {
	campaignId: Id<'campaigns'>;
	initialData?: {
		campaignSubject: string;
	};
}

const props = withDefaults(defineProps<Props>(), {
	initialData: () => ({
		campaignSubject: '',
	}),
});

const emit = defineEmits<{
	submit: [];
	back: [];
}>();

const campaignSubject = ref(props.initialData.campaignSubject);
const selectionType = ref<EmailSelectionType>('existing');
const selectedTemplateId = ref<Id<'emailTemplates'> | null>(null);
const newTemplateName = ref('');

const subjectError = ref('');
const contentError = ref('');
const createdTemplate = ref<{
	_id: Id<'emailTemplates'>;
	name: string;
	subject: string;
} | null>(null);
const { t } = useI18n();

const { data: campaignWithRelations } = useConvexQuery(
	api.campaigns.campaigns.getWithRelations,
	() => ({
		campaignId: props.campaignId,
	})
);

// Read on its own: the picker pages and searches, so the selection is often
// not among the rows it shows.
const { data: selectedTemplateById } = useEmailTemplateById(selectedTemplateId);

watch(
	campaignWithRelations,
	(campaign) => {
		if (!campaign) return;

		if (!selectedTemplateId.value && campaign.emailTemplateId) {
			selectedTemplateId.value = campaign.emailTemplateId;
			selectionType.value = 'existing';
		}

		if (!newTemplateName.value.trim()) {
			newTemplateName.value = t('components.campaigns.steps.contentStep.templateNameDefault', {
				name: campaign.name,
			});
		}

		if (!campaignSubject.value.trim()) {
			campaignSubject.value = campaign.subject ?? campaign.emailTemplate?.subject ?? '';
		}
	},
	{ immediate: true }
);

const selectedTemplate = computed(() => {
	if (!selectedTemplateId.value) return null;

	if (selectedTemplateById.value?._id === selectedTemplateId.value) {
		return selectedTemplateById.value;
	}

	if (campaignWithRelations.value?.emailTemplate?._id === selectedTemplateId.value) {
		return campaignWithRelations.value.emailTemplate;
	}

	if (createdTemplate.value?._id === selectedTemplateId.value) {
		return createdTemplate.value;
	}

	return null;
});

const handleTemplateSelect = (template: Doc<'emailTemplates'>) => {
	selectedTemplateId.value = template._id;
	selectionType.value = 'existing';
	contentError.value = '';

	if (!campaignSubject.value.trim() && template.subject) {
		campaignSubject.value = template.subject;
	}
};

const { run: updateContent } = useBackendOperation(api.campaigns.campaigns.updateContent, {
	label: () => t('components.campaigns.steps.contentStep.updateContentOperation'),
});
const { run: createTemplate } = useBackendOperation(api.emailTemplates.emails.create, {
	label: () => t('components.campaigns.steps.contentStep.createTemplateOperation'),
});
// Only the loading flag is needed; validation surfaces via `subjectError` /
// `contentError` and backend errors are surfaced by the operation module.
const { isLoading, setLoading } = useModal();

const validate = (): boolean => {
	subjectError.value = '';
	contentError.value = '';

	if (selectionType.value === 'existing' && !selectedTemplateId.value) {
		contentError.value = t('components.campaigns.steps.contentStep.errors.selectTemplate');
		return false;
	}

	if (selectionType.value === 'new' && !newTemplateName.value.trim()) {
		contentError.value = t('components.campaigns.steps.contentStep.errors.templateName');
		return false;
	}

	if (!campaignSubject.value.trim()) {
		subjectError.value = t('components.campaigns.steps.contentStep.errors.subjectRequired');
		return false;
	}

	return true;
};

const handleSubmit = async () => {
	if (!validate()) return;

	setLoading(true);
	try {
		let templateId = selectedTemplateId.value;

		if (selectionType.value === 'new') {
			const newId = await createTemplate({
				name: newTemplateName.value.trim(),
				type: 'marketing',
				subject: campaignSubject.value.trim(),
			});

			if (!newId.ok) return;

			templateId = newId.result;
			selectedTemplateId.value = newId.result;
			selectionType.value = 'existing';
			createdTemplate.value = {
				_id: newId.result,
				name: newTemplateName.value.trim(),
				subject: campaignSubject.value.trim(),
			};
		}

		const result = await updateContent({
			campaignId: props.campaignId,
			emailTemplateId: templateId!,
			subject: campaignSubject.value.trim(),
		});
		if (!result.ok) return;

		emit('submit');
	} finally {
		setLoading(false);
	}
};

defineExpose({
	selectedTemplate,
	campaignSubject,
});
</script>

<template>
	<div class="card p-6">
		<div class="mb-6">
			<h2 class="text-xl font-semibold text-text-primary">
				{{ t('components.campaigns.steps.contentStep.title') }}
			</h2>
			<p class="text-text-secondary mt-1">
				{{ t('components.campaigns.steps.contentStep.subtitle') }}
			</p>
		</div>

		<form @submit.prevent="handleSubmit">
			<div class="space-y-6">
				<div class="space-y-3">
					<label class="label"
						>{{ t('components.campaigns.steps.contentStep.choiceLabel') }}
						<span class="text-error">*</span></label
					>
					<label
						:class="[
							'flex items-start gap-3 p-4 border rounded-lg cursor-pointer transition-colors',
							selectionType === 'existing'
								? 'border-text-primary bg-bg-surface'
								: 'border-border-subtle hover:border-border-default',
						]"
					>
						<input
							v-model="selectionType"
							type="radio"
							name="emailSelectionType"
							value="existing"
							class="mt-1 w-4 h-4 text-text-primary"
						/>
						<div>
							<p class="font-medium text-text-primary">
								{{ t('components.campaigns.steps.contentStep.existingTitle') }}
							</p>
							<p class="text-sm text-text-secondary">
								{{ t('components.campaigns.steps.contentStep.existingDescription') }}
							</p>
						</div>
					</label>
					<label
						:class="[
							'flex items-start gap-3 p-4 border rounded-lg cursor-pointer transition-colors',
							selectionType === 'new'
								? 'border-text-primary bg-bg-surface'
								: 'border-border-subtle hover:border-border-default',
						]"
					>
						<input
							v-model="selectionType"
							type="radio"
							name="emailSelectionType"
							value="new"
							class="mt-1 w-4 h-4 text-text-primary"
						/>
						<div>
							<p class="font-medium text-text-primary">
								{{ t('components.campaigns.steps.contentStep.newTitle') }}
							</p>
							<p class="text-sm text-text-secondary">
								{{ t('components.campaigns.steps.contentStep.newDescription') }}
							</p>
						</div>
					</label>
				</div>

				<div v-if="selectionType === 'existing'">
					<label for="templateSearch" class="label text-sm">{{
						t('components.campaigns.steps.contentStep.existingTemplatesLabel')
					}}</label>
					<EmailTemplatePicker
						:model-value="selectedTemplateId"
						input-id="templateSearch"
						class="mt-1.5"
						@select="handleTemplateSelect"
					/>
				</div>

				<div v-else>
					<label for="newTemplateName" class="label text-sm">{{
						t('components.campaigns.steps.contentStep.newTemplateNameLabel')
					}}</label>
					<input
						id="newTemplateName"
						v-model="newTemplateName"
						type="text"
						:placeholder="t('components.campaigns.steps.contentStep.newTemplateNamePlaceholder')"
						class="input mt-1.5"
					/>
					<p class="mt-1.5 text-sm text-text-tertiary">
						{{ t('components.campaigns.steps.contentStep.newTemplateNameHint') }}
					</p>
				</div>

				<div
					v-if="selectedTemplate"
					class="p-4 bg-bg-surface border border-border-default rounded-lg"
				>
					<p class="text-sm text-text-secondary">
						{{ t('components.campaigns.steps.contentStep.selectedTemplate') }}
					</p>
					<div class="mt-1 flex items-center gap-2">
						<Icon name="lucide:mail" class="w-4 h-4 text-text-tertiary" />
						<p class="font-medium text-text-primary truncate">{{ selectedTemplate.name }}</p>
					</div>
					<p class="text-sm text-text-secondary truncate mt-1">
						{{ selectedTemplate.subject || t('components.campaigns.steps.contentStep.noSubject') }}
					</p>
				</div>

				<p v-if="contentError" class="text-sm text-error">
					{{ contentError }}
				</p>

				<div>
					<label for="campaignSubject" class="label flex items-center gap-2">
						<Icon name="lucide:mail" class="w-4 h-4 text-text-tertiary" />
						{{ t('components.campaigns.steps.contentStep.subjectLabel') }}
						<span class="text-error">*</span>
					</label>
					<input
						id="campaignSubject"
						v-model="campaignSubject"
						type="text"
						:placeholder="t('components.campaigns.steps.contentStep.subjectPlaceholder')"
						:class="['input mt-1.5', subjectError ? 'input-error' : '']"
					/>
					<p v-if="subjectError" class="mt-1.5 text-sm text-error">
						{{ subjectError }}
					</p>
				</div>
			</div>

			<div class="flex items-center justify-between mt-8 pt-6 border-t border-border-subtle">
				<UiButton variant="secondary" @click="emit('back')">
					<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4" /></template>
					{{ t('common.back') }}
				</UiButton>
				<UiButton type="submit" :loading="isLoading" :disabled="isLoading">
					{{ isLoading ? t('common.saving') : t('common.next') }}
					<template v-if="!isLoading" #iconRight
						><Icon name="lucide:arrow-right" class="w-4 h-4"
					/></template>
				</UiButton>
			</div>
		</form>
	</div>
</template>
