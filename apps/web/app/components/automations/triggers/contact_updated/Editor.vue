<script setup lang="ts">
import type { Doc } from '@owlat/api/dataModel';
import type { ContactUpdatedTriggerConfig } from '~/composables/automations/triggers';

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
			Property to Watch <span class="text-error">*</span>
		</label>
		<p class="text-sm text-text-tertiary mt-1 mb-3">
			This automation will trigger when the selected property changes for any contact.
		</p>
		<select
			id="propertyKey"
			:value="modelValue.propertyKey"
			:class="['input', error ? 'input-error' : '']"
			@change="updatePropertyKey"
		>
			<option value="" disabled>Select a property...</option>
			<!-- Only the fields `contacts.update` records in changedProperties can
				fire this trigger. 'Subscribed Status' (no contact-level field) and
				custom properties never produced a run, so they are intentionally not
				offered here to avoid silently-dead automations. -->
			<optgroup label="Built-in Properties">
				<option value="email">Email</option>
				<option value="firstName">First Name</option>
				<option value="lastName">Last Name</option>
				<option value="timezone">Timezone</option>
				<option value="language">Language</option>
			</optgroup>
		</select>
		<p v-if="error" class="mt-2 text-sm text-error">{{ error }}</p>
	</div>
</template>
