<script setup lang="ts">
import type { Doc, Id } from '@owlat/api/dataModel';
import type { EmailStepConfig } from '~/composables/automations/steps';

const props = defineProps<{
	modelValue: EmailStepConfig;
	emailTemplates: Doc<'emailTemplates'>[] | null | undefined;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: EmailStepConfig];
	save: [];
}>();

const onTemplateChange = (event: Event) => {
	const value = (event.target as HTMLSelectElement).value;
	emit('update:modelValue', {
		...props.modelValue,
		emailTemplateId: value,
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

const selectedTemplate = computed(() =>
	props.emailTemplates?.find((t) => t._id === props.modelValue.emailTemplateId)
);
</script>

<template>
	<div class="space-y-6">
		<div>
			<label class="label flex items-center gap-2 mb-2">
				<Icon name="lucide:mail" class="w-4 h-4 text-brand" />
				Email Template
			</label>
			<select :value="modelValue.emailTemplateId" class="input" @change="onTemplateChange">
				<option value="">Select a template...</option>
				<option v-for="template in emailTemplates" :key="template._id" :value="template._id">
					{{ template.name }} ({{ template.status }})
				</option>
			</select>
			<p class="text-xs text-text-tertiary mt-1.5">
				Choose the email template to send to the contact.
			</p>

			<div
				v-if="!emailTemplates?.length"
				class="mt-3 p-3 bg-warning/10 border border-warning/20 rounded-lg"
			>
				<p class="text-sm text-warning">
					No automation templates found.
					<NuxtLink to="/dashboard/send/marketing" class="underline">
						Create an email template
					</NuxtLink>
					with type "Automation" first.
				</p>
			</div>

			<div class="mt-3 p-3 bg-bg-surface border border-border-subtle rounded-lg">
				<p class="text-sm text-text-secondary mb-2">
					Or create a new email template for this automation:
				</p>
				<NuxtLink to="/dashboard/send/marketing" class="btn btn-secondary btn-sm gap-2 w-full">
					<Icon name="lucide:plus" class="w-4 h-4" />
					Create New Email
				</NuxtLink>
			</div>
		</div>

		<div>
			<label for="subjectOverride" class="label">Subject Line Override (optional)</label>
			<input
				id="subjectOverride"
				:value="modelValue.subjectOverride ?? ''"
				type="text"
				placeholder="Leave blank to use template subject"
				class="input mt-1.5"
				@blur="onSubjectBlur"
			/>
			<p class="text-xs text-text-tertiary mt-1.5">
				Override the template's subject line for this automation.
			</p>
		</div>

		<div v-if="selectedTemplate" class="p-4 bg-bg-surface border border-border-subtle rounded-lg">
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-2">
				Template Preview
			</p>
			<div class="space-y-1">
				<p class="text-sm font-medium text-text-primary">{{ selectedTemplate.name }}</p>
				<p class="text-sm text-text-secondary">
					Subject: {{ modelValue.subjectOverride || selectedTemplate.subject }}
				</p>
				<NuxtLink
					:to="`/dashboard/send/emails/${selectedTemplate._id}/edit`"
					class="text-sm text-brand hover:underline"
				>
					Edit template →
				</NuxtLink>
			</div>
		</div>
	</div>
</template>
