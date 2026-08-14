<script setup lang="ts">
import type { EventReceivedTriggerConfig } from '~/composables/automations/triggers';

const { t } = useI18n();

const props = defineProps<{
	modelValue: EventReceivedTriggerConfig;
	error?: string;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: EventReceivedTriggerConfig];
}>();

const updateEventName = (event: Event) => {
	const eventName = (event.target as HTMLInputElement).value;
	emit('update:modelValue', { ...props.modelValue, eventName });
};
</script>

<template>
	<div>
		<label for="eventName" class="label flex items-center gap-2">
			<Icon name="lucide:radio" class="w-4 h-4 text-warning" />
			{{ t('components.automations.triggers.eventReceived.editor.eventNameLabel') }}
			<span class="text-error">*</span>
		</label>
		<p class="text-sm text-text-tertiary mt-1 mb-3">
			{{ t('components.automations.triggers.eventReceived.editor.eventNameHint') }}
		</p>
		<input
			id="eventName"
			:value="modelValue.eventName"
			type="text"
			:placeholder="t('components.automations.triggers.eventReceived.editor.eventNamePlaceholder')"
			:class="['input', error ? 'input-error' : '']"
			@input="updateEventName"
		/>
		<p v-if="error" class="mt-2 text-sm text-error">{{ error }}</p>
		<div class="mt-3 p-3 bg-bg-elevated border border-border-subtle rounded-lg">
			<p class="text-xs text-text-tertiary font-mono">
				POST /api/v1/events<br />
				{{
					'{ "email": "user@example.com", "eventName": "' +
					(modelValue.eventName || 'your_event') +
					'" }'
				}}
			</p>
		</div>
	</div>
</template>
