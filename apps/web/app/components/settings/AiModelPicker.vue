<script setup lang="ts">
/**
 * A curated-model dropdown with a free-text override, for the AI-provider
 * settings page. Choosing the "Custom model id…" sentinel reveals a text input.
 * Two `defineModel`s so the parent keeps the dropdown `choice` and the `custom`
 * text as separate form fields — `resolveModelId(choice, custom)` collapses them
 * back to the effective id at save time.
 */
import { CUSTOM_MODEL_VALUE, type SelectOption } from '~/utils/aiProviders';

defineProps<{
	label: string;
	options: SelectOption[];
	hint?: string;
	disabled?: boolean;
}>();

const choice = defineModel<string>('choice', { required: true });
const custom = defineModel<string>('custom', { required: true });
</script>

<template>
	<div>
		<UiSelect v-model="choice" :label="label" :options="options" :disabled="disabled" />
		<UiInput
			v-if="choice === CUSTOM_MODEL_VALUE"
			v-model="custom"
			type="text"
			class="mt-2"
			placeholder="Enter a model id"
			:disabled="disabled"
		/>
		<p v-if="hint" class="mt-1.5 text-xs text-text-tertiary">{{ hint }}</p>
	</div>
</template>
