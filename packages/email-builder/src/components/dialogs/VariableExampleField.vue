<script setup lang="ts">
/**
 * The input for one data variable's example value, by type. An empty input is
 * no example. A list is pasted as JSON and checked with the rules the server
 * applies (`@owlat/shared/dataVariableExamples`), so a value the dialog
 * accepts is one the save accepts.
 */
import { computed, ref, watch } from 'vue';
import {
	dataVariableExampleError,
	type DataVariableExampleValue,
} from '@owlat/shared/dataVariableExamples';
import { MAX_REPEAT_ITEMS } from '@owlat/shared/sendRegions';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

type DataVariableType = 'string' | 'number' | 'boolean' | 'date' | 'array';

// The explicit `undefined` default matters: `initial` may be a boolean, and
// Vue reads an absent boolean prop as `false`, which would start every field
// with the example `false`.
const props = withDefaults(
	defineProps<{
		type: DataVariableType;
		/** The example the field starts from. */
		initial?: DataVariableExampleValue;
		/** The input's id, for the caller's label. */
		inputId: string;
	}>(),
	{ initial: undefined }
);

const emit = defineEmits<{
	/** The parsed example (`undefined` for none), or `valid: false` while the input is not one. */
	(
		e: 'change',
		result: { valid: true; value: DataVariableExampleValue | undefined } | { valid: false }
	): void;
}>();

const { t } = useBuilderI18n();

// Shown as written: they are the values a send passes, in every language.
const BOOLEAN_VALUES = ['true', 'false'] as const;

const LIST_PLACEHOLDER = '[{ "name": "Notebook", "quantity": 2 }]';

const textOf = (value: DataVariableExampleValue | undefined): string => {
	if (value === undefined) return '';
	if (Array.isArray(value)) return JSON.stringify(value, null, 2);
	return String(value);
};

const text = ref<string | number>(textOf(props.initial));

// A date picker cannot show a stored timestamp (`2026-11-25T09:30:00Z`, which
// the API accepts), so such an example is edited as text.
const isPlainDate = (value: DataVariableExampleValue | undefined) =>
	value === undefined || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
const dateInputType = computed(() => (isPlainDate(props.initial) ? 'date' : 'text'));

watch(
	() => [props.type, props.initial] as const,
	([, initial]) => {
		text.value = textOf(initial);
	}
);

/** The input read as the variable's type: a value, none, or an error key. */
const parsed = computed<
	{ value: DataVariableExampleValue | undefined } | { error: 'json' | 'list' | 'number' | 'date' }
>(() => {
	// `v-model` on a number input hands back a number, not the text.
	const raw = String(text.value).trim();
	if (raw === '') return { value: undefined };
	switch (props.type) {
		case 'number': {
			const value = Number(raw);
			return Number.isFinite(value) ? { value } : { error: 'number' };
		}
		case 'boolean':
			return { value: raw === 'true' };
		case 'date':
			return dataVariableExampleError('date', raw) === null ? { value: raw } : { error: 'date' };
		case 'array': {
			let value: unknown;
			try {
				value = JSON.parse(raw);
			} catch {
				return { error: 'json' };
			}
			return dataVariableExampleError('array', value) === null
				? { value: value as DataVariableExampleValue }
				: { error: 'list' };
		}
		default:
			return { value: String(text.value) };
	}
});

const errorMessage = computed(() => {
	const result = parsed.value;
	if (!('error' in result)) return null;
	return t(`builder.variableDialog.exampleErrors.${result.error}`, { max: MAX_REPEAT_ITEMS });
});

watch(
	parsed,
	(result) => {
		emit('change', 'error' in result ? { valid: false } : { valid: true, value: result.value });
	},
	{ immediate: true }
);

const errorId = computed(() => `${props.inputId}-error`);
</script>

<template>
	<div>
		<select
			v-if="type === 'boolean'"
			:id="inputId"
			v-model="text"
			class="input"
			data-testid="variable-example-input"
		>
			<option value="">{{ t('builder.variableDialog.exampleNone') }}</option>
			<option v-for="value in BOOLEAN_VALUES" :key="value" :value="value">{{ value }}</option>
		</select>
		<textarea
			v-else-if="type === 'array'"
			:id="inputId"
			v-model="text"
			rows="5"
			class="input font-mono text-xs"
			:class="{ 'input-error': errorMessage }"
			:placeholder="LIST_PLACEHOLDER"
			spellcheck="false"
			:aria-invalid="errorMessage ? true : undefined"
			:aria-describedby="errorMessage ? errorId : undefined"
			data-testid="variable-example-input"
		/>
		<input
			v-else
			:id="inputId"
			v-model="text"
			:type="type === 'number' ? 'number' : type === 'date' ? dateInputType : 'text'"
			class="input"
			:class="{ 'input-error': errorMessage }"
			:aria-invalid="errorMessage ? true : undefined"
			:aria-describedby="errorMessage ? errorId : undefined"
			data-testid="variable-example-input"
		/>
		<p v-if="errorMessage" :id="errorId" class="text-xs text-error mt-2" role="alert">
			{{ errorMessage }}
		</p>
		<p class="text-xs text-text-tertiary mt-2">{{ t('builder.variableDialog.exampleHint') }}</p>
	</div>
</template>
