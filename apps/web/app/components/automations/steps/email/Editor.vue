<script setup lang="ts">
import type { Doc, Id } from '@owlat/api/dataModel';
import type { EmailStepConfig } from '~/composables/automations/steps';

const { t } = useI18n();

const props = defineProps<{
	modelValue: EmailStepConfig;
	/**
	 * The builder page's first page of templates, still forwarded by the step
	 * panel. Not read here: the picker below searches and pages its own list.
	 */
	emailTemplates?: Doc<'emailTemplates'>[] | null | undefined;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: EmailStepConfig];
	save: [];
}>();

const onTemplateChange = (templateId: Id<'emailTemplates'>) => {
	if (templateId === props.modelValue.emailTemplateId) return;
	emit('update:modelValue', {
		...props.modelValue,
		emailTemplateId: templateId,
	});
	emit('save');
};

const onSubjectBlur = (event: Event) => {
	emit('update:modelValue', {
		...props.modelValue,
		subjectOverride: (event.target as HTMLInputElement).value || undefined,
	});
	emit('save');
};

// Read by id, not looked up in a list: the selection may be on a page the
// picker has not loaded, or outside the current search.
const selectedTemplateId = computed(
	() => (props.modelValue.emailTemplateId || null) as Id<'emailTemplates'> | null
);
const { data: selectedTemplate } = useEmailTemplateById(selectedTemplateId);
</script>

<template>
	<div class="space-y-6">
		<div>
			<label for="emailStepTemplate" class="label flex items-center gap-2 mb-2">
				<Icon name="lucide:mail" class="w-4 h-4 text-brand" />
				{{ t('components.automations.steps.email.editor.templateLabel') }}
			</label>
			<p class="text-xs text-text-tertiary mb-2">
				{{ t('components.automations.steps.email.editor.templateHint') }}
			</p>
			<EmailTemplatePicker
				:model-value="selectedTemplateId"
				input-id="emailStepTemplate"
				@update:model-value="onTemplateChange"
			>
				<template #none>
					<I18nT
						keypath="components.automations.steps.email.editor.noTemplates"
						tag="span"
						scope="global"
					>
						<template #link>
							<NuxtLink to="/dashboard/send/marketing" class="underline">
								{{ t('components.automations.steps.email.editor.noTemplatesLink') }}
							</NuxtLink>
						</template>
					</I18nT>
				</template>
			</EmailTemplatePicker>

			<div class="mt-3 p-3 bg-bg-surface border border-border-subtle rounded-lg">
				<p class="text-sm text-text-secondary mb-2">
					{{ t('components.automations.steps.email.editor.createPrompt') }}
				</p>
				<UiButton
					variant="secondary"
					size="sm"
					full-width
					to="/dashboard/send/marketing"
					class="gap-2"
				>
					<Icon name="lucide:plus" class="w-4 h-4" />
					{{ t('components.automations.steps.email.editor.createCta') }}
				</UiButton>
			</div>
		</div>

		<div>
			<label for="subjectOverride" class="label">
				{{ t('components.automations.steps.email.editor.subjectLabel') }}
			</label>
			<input
				id="subjectOverride"
				:value="modelValue.subjectOverride ?? ''"
				type="text"
				:placeholder="t('components.automations.steps.email.editor.subjectPlaceholder')"
				class="input mt-1.5"
				@blur="onSubjectBlur"
			/>
			<p class="text-xs text-text-tertiary mt-1.5">
				{{ t('components.automations.steps.email.editor.subjectHint') }}
			</p>
		</div>

		<div v-if="selectedTemplate" class="p-4 bg-bg-surface border border-border-subtle rounded-lg">
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-2">
				{{ t('components.automations.steps.email.editor.previewLabel') }}
			</p>
			<div class="space-y-1">
				<p class="text-sm font-medium text-text-primary">{{ selectedTemplate.name }}</p>
				<p class="text-sm text-text-secondary">
					{{
						t('components.automations.steps.email.editor.previewSubject', {
							subject: modelValue.subjectOverride || selectedTemplate.subject,
						})
					}}
				</p>
				<NuxtLink
					:to="`/dashboard/send/emails/${selectedTemplate._id}/edit`"
					class="text-sm text-brand hover:underline"
				>
					{{ t('components.automations.steps.email.editor.editTemplate') }}
				</NuxtLink>
			</div>
		</div>
	</div>
</template>
