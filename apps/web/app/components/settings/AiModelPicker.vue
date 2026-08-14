<script setup lang="ts">
/**
 * A curated-model dropdown with a free-text override, for the AI-provider
 * settings page. Choosing the "Custom model id…" sentinel reveals a text input.
 * Two `defineModel`s so the parent keeps the dropdown `choice` and the `custom`
 * text as separate form fields — `resolveModelId(choice, custom)` collapses them
 * back to the effective id at save time.
 */
import { CUSTOM_MODEL_VALUE, type AiProviderText, type SelectOption } from '~/utils/aiProviders';

const props = defineProps<{
	label: string;
	options: SelectOption[];
	hint?: string;
	disabled?: boolean;
}>();

const choice = defineModel<string>('choice', { required: true });
const custom = defineModel<string>('custom', { required: true });

const { t, te } = useI18n();

/**
 * `SelectOption.label` is copy as a message key (or a `{ key, params }` pair)
 * and data — a model id — verbatim. `UiSelect` takes rendered strings, so the
 * resolution happens here: a key is translated, an id has no catalog entry and
 * passes through unchanged.
 */
const localized = (text: AiProviderText): string =>
	typeof text === 'string' ? (te(text) ? t(text) : text) : t(text.key, text.params ?? {});

const selectOptions = computed(() =>
	props.options.map((option) => ({ value: option.value, label: localized(option.label) }))
);
</script>

<template>
	<div>
		<UiSelect v-model="choice" :label="label" :options="selectOptions" :disabled="disabled" />
		<UiInput
			v-if="choice === CUSTOM_MODEL_VALUE"
			v-model="custom"
			type="text"
			class="mt-2"
			:placeholder="t('components.settings.aiModelPicker.customPlaceholder')"
			:disabled="disabled"
		/>
		<p v-if="hint" class="mt-1.5 text-xs text-text-tertiary">{{ hint }}</p>
	</div>
</template>
