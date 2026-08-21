<script setup lang="ts">
import type { Doc } from '@owlat/api/dataModel';
import type { ContactUpdatedTriggerConfig } from '~/composables/automations/triggers';

const { t } = useI18n();

const props = defineProps<{
	modelValue: ContactUpdatedTriggerConfig;
	contactProperties: Doc<'contactProperties'>[] | null | undefined;
	error?: string;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: ContactUpdatedTriggerConfig];
}>();

const updatePropertyKey = (event: Event) => {
	const propertyKey = (event.target as HTMLSelectElement).value;
	emit('update:modelValue', { ...props.modelValue, propertyKey });
};
</script>

<template>
	<div>
		<label for="propertyKey" class="label flex items-center gap-2">
			<Icon name="lucide:user-cog" class="w-4 h-4 text-brand" />
			{{ t('components.automations.triggers.contactUpdated.editor.propertyLabel') }}
			<span class="text-error">*</span>
		</label>
		<p class="text-sm text-text-tertiary mt-1 mb-3">
			{{ t('components.automations.triggers.contactUpdated.editor.propertyHint') }}
		</p>
		<select
			id="propertyKey"
			:value="modelValue.propertyKey"
			:class="['input', error ? 'input-error' : '']"
			@change="updatePropertyKey"
		>
			<option value="" disabled>
				{{ t('components.automations.triggers.contactUpdated.editor.propertyPlaceholder') }}
			</option>
			<!-- Only the fields `contacts.update` records in changedProperties can
				fire this trigger. 'Subscribed Status' (no contact-level field) and
				custom properties never produced a run, so they are intentionally not
				offered here to avoid silently-dead automations. -->
			<optgroup :label="t('components.automations.triggers.contactUpdated.editor.builtInGroup')">
				<option value="email">
					{{ t('components.automations.triggers.contactUpdated.editor.properties.email') }}
				</option>
				<option value="firstName">
					{{ t('components.automations.triggers.contactUpdated.editor.properties.firstName') }}
				</option>
				<option value="lastName">
					{{ t('components.automations.triggers.contactUpdated.editor.properties.lastName') }}
				</option>
				<option value="timezone">
					{{ t('components.automations.triggers.contactUpdated.editor.properties.timezone') }}
				</option>
				<option value="language">
					{{ t('components.automations.triggers.contactUpdated.editor.properties.language') }}
				</option>
			</optgroup>
		</select>
		<p v-if="error" class="mt-2 text-sm text-error">{{ error }}</p>
	</div>
</template>
