<script setup lang="ts">
import { computed } from 'vue';
import type { PropertyField as PropertyFieldType } from '../../schema/types';
import type { EditorBlock, Variable, EmailTheme, GradientBackground } from '../../types';

// Field sub-components
import ColorField from './fields/ColorField.vue';
import NumberField from './fields/NumberField.vue';
import SliderField from './fields/SliderField.vue';
import AlignField from './fields/AlignField.vue';
import ImageField from './fields/ImageField.vue';
import ToggleField from './fields/ToggleField.vue';
import SelectField from './fields/SelectField.vue';
import TextField from './fields/TextField.vue';

// Complex editors
import RichTextEditor from './RichTextEditor.vue';
import ArrayEditor from './ArrayEditor.vue';
import SpacingEditor from './SpacingEditor.vue';
import MarginEditor from './MarginEditor.vue';
import BorderEditor from './BorderEditor.vue';
import GradientEditor from './GradientEditor.vue';

// Shared UI
import FieldLabel from '../ui/FieldLabel.vue';

import type { BlockCondition, BlockRepeat } from '../../types';
import {
	type ConditionOperator,
	conditionOperatorOptions,
	conditionNeedsValue as operatorNeedsValue,
	normalizeCondition,
	DEFAULT_CONDITION_OPERATOR,
} from '../../utils/blockCondition';
import { normalizeRepeat, DEFAULT_ITEM_ALIAS } from '../../utils/blockRepeat';

const props = defineProps<{
	field: PropertyFieldType;
	value: unknown;
	block: EditorBlock;
	theme: Required<EmailTheme>;
	variables?: Variable[];
	onUploadImage?: (file: File) => Promise<{ url: string; storageId?: string }>;
}>();

const emit = defineEmits<{
	(e: 'update', value: unknown): void;
	(e: 'update-keyed', key: string, value: unknown): void;
}>();

const stringValue = computed(() => (props.value as string) ?? '');
const numberValue = computed(() => (props.value as number) ?? 0);
const booleanValue = computed(() => (props.value as boolean) ?? false);

// Condition editor ----------------------------------------------------------
const condition = computed(() => (props.value as Partial<BlockCondition> | undefined) ?? {});
const conditionOperator = computed<ConditionOperator>(
	() => condition.value.operator ?? DEFAULT_CONDITION_OPERATOR,
);
/** equals/notEquals/contains compare against a value; exists/notExists do not */
const conditionNeedsValue = computed(() => operatorNeedsValue(conditionOperator.value));

function updateCondition(patch: Partial<BlockCondition>) {
	// Always write a COMPLETE condition so the renderer has the operator it switches on.
	// (Without operator, evaluateCondition() hits `default: return true` and never hides.)
	emit('update', normalizeCondition(condition.value, patch));
}

// Repeat editor -------------------------------------------------------------
const repeat = computed(() => (props.value as Partial<BlockRepeat> | undefined) ?? {});

// Literal placeholder example shown in the help text, e.g. `{{item.key}}`.
// Built here in script rather than inline in the template: an interpolation
// like `{{ '{{' + alias + '.key}}' }}` makes the SFC compiler mis-read the
// inner `}}` as the end of the interpolation and fails the build.
const itemRefExample = computed(() => `{{${repeat.value.itemAlias || DEFAULT_ITEM_ALIAS}.key}}`);

function updateRepeat(patch: Partial<BlockRepeat>) {
	// Always write a COMPLETE repeat so the renderer can build `{{itemAlias.key}}`
	// placeholders. Without a non-empty itemAlias the loop emits un-substituted content.
	emit('update', normalizeRepeat(repeat.value, patch));
}

function updateRepeatMaxItems(raw: string) {
	const trimmed = raw.trim();
	if (trimmed === '') {
		// Clear the cap → unlimited (up to the renderer's safety ceiling).
		updateRepeat({ maxItems: undefined });
		return;
	}
	const parsed = Number.parseInt(trimmed, 10);
	if (Number.isFinite(parsed)) updateRepeat({ maxItems: parsed });
}

/** Inline layout: label left, control right (toggle, number, slider) */
const isInlineLayout = computed(() => {
	return ['toggle', 'number', 'slider'].includes(props.field.type);
});

const fontFamilyOptions = [
	{ label: 'Default', value: '' },
	{ label: 'Arial', value: 'Arial, sans-serif' },
	{ label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
	{ label: 'Georgia', value: 'Georgia, serif' },
	{ label: 'Times New Roman', value: "'Times New Roman', Times, serif" },
	{ label: 'Courier New', value: "'Courier New', Courier, monospace" },
	{ label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
	{ label: 'Trebuchet MS', value: "'Trebuchet MS', sans-serif" },
	{ label: 'Tahoma', value: 'Tahoma, Geneva, sans-serif' },
];
</script>

<template>
	<div
		class="flex flex-col gap-[5px]"
		:class="{ 'flex-row items-center justify-between gap-3 min-h-[34px]': isInlineLayout }"
	>
		<!-- Label: always shown except for toggle (which has its own label) -->
		<FieldLabel
			v-if="field.type !== 'toggle'"
			:class="{ 'shrink-0 min-w-0': isInlineLayout }"
		>
			{{ field.label }}
		</FieldLabel>

		<!-- Toggle (uses its own inline label) -->
		<ToggleField
			v-if="field.type === 'toggle'"
			:value="booleanValue"
			:label="field.label"
			@update="(val) => emit('update', val)"
		/>

		<!-- Text input -->
		<TextField
			v-else-if="field.type === 'text'"
			:value="stringValue"
			:placeholder="field.placeholder"
			@update="(val) => emit('update', val)"
		/>

		<!-- Textarea -->
		<textarea
			v-else-if="field.type === 'textarea'"
			class="w-full py-2 px-2.5 text-xs font-mono border border-border-subtle rounded-lg bg-bg-surface text-text-primary resize-y outline-none eb-input-ring"
			:value="stringValue"
			:placeholder="field.placeholder"
			rows="6"
			@input="(e) => emit('update', (e.target as HTMLTextAreaElement).value)"
		/>

		<!-- Rich text editor -->
		<RichTextEditor
			v-else-if="field.type === 'richtext'"
			:value="stringValue"
			:variables="variables"
			@update="(val) => emit('update', val)"
		/>

		<!-- Number input -->
		<NumberField
			v-else-if="field.type === 'number'"
			:value="numberValue"
			:min="field.min"
			:max="field.max"
			:step="field.step"
			:unit="field.unit"
			@update="(val) => emit('update', val)"
		/>

		<!-- Slider -->
		<SliderField
			v-else-if="field.type === 'slider'"
			:value="numberValue"
			:min="field.min"
			:max="field.max"
			:step="field.step"
			:unit="field.unit"
			@update="(val) => emit('update', val)"
		/>

		<!-- Color picker -->
		<ColorField
			v-else-if="field.type === 'color'"
			:value="stringValue"
			:placeholder="field.placeholder"
			@update="(val) => emit('update', val)"
		/>

		<!-- Select dropdown -->
		<SelectField
			v-else-if="field.type === 'select'"
			:value="value"
			:options="field.options ?? []"
			@update="(val) => emit('update', val)"
		/>

		<!-- URL input -->
		<TextField
			v-else-if="field.type === 'url'"
			:value="stringValue"
			:placeholder="field.placeholder ?? 'https://'"
			type="url"
			@update="(val) => emit('update', val)"
		/>

		<!-- Date input -->
		<input
			v-else-if="field.type === 'date'"
			type="datetime-local"
			class="w-full py-2 px-2.5 text-[13px] border border-border-subtle rounded-lg bg-bg-surface text-text-primary outline-none eb-input-ring"
			:value="stringValue ? stringValue.slice(0, 16) : ''"
			@input="(e) => emit('update', new Date((e.target as HTMLInputElement).value).toISOString())"
		/>

		<!-- Image upload -->
		<ImageField
			v-else-if="field.type === 'image'"
			:value="stringValue"
			:on-upload-image="onUploadImage"
			@update="(val) => emit('update', val)"
		/>

		<!-- Alignment selector -->
		<AlignField
			v-else-if="field.type === 'align'"
			:value="stringValue"
			:options="field.alignOptions"
			@update="(val) => emit('update', val)"
		/>

		<!-- Spacing editor -->
		<SpacingEditor
			v-else-if="field.type === 'spacing'"
			:block="block"
			@update="(key, val) => $emit('update-keyed', key, val)"
		/>

		<!-- Margin editor -->
		<MarginEditor
			v-else-if="field.type === 'margin'"
			:block="block"
			@update="(key, val) => $emit('update-keyed', key, val)"
		/>

		<!-- Border editor -->
		<BorderEditor
			v-else-if="field.type === 'border'"
			:block="block"
			@update="(key, val) => emit('update', val)"
		/>

		<!-- Gradient editor -->
		<GradientEditor
			v-else-if="field.type === 'gradient'"
			:model-value="(value as GradientBackground | undefined)"
			@update:model-value="(val) => emit('update', val)"
		/>

		<!-- Font family -->
		<SelectField
			v-else-if="field.type === 'fontFamily'"
			:value="stringValue"
			:options="fontFamilyOptions"
			placeholder="Default"
			@update="(val) => emit('update', val)"
		/>

		<!-- Array editor -->
		<ArrayEditor
			v-else-if="field.type === 'array'"
			:field="field"
			:value="(value as unknown[])"
			@update="(val) => emit('update', val)"
		/>

		<!-- Condition: show/hide the block based on a variable -->
		<div v-else-if="field.type === 'condition'" class="flex flex-col gap-[5px]">
			<TextField
				:value="condition.variable ?? ''"
				placeholder="Variable name"
				@update="(v) => updateCondition({ variable: v })"
			/>
			<SelectField
				:value="conditionOperator"
				:options="conditionOperatorOptions"
				@update="(v) => updateCondition({ operator: v as ConditionOperator })"
			/>
			<TextField
				v-if="conditionNeedsValue"
				:value="condition.value ?? ''"
				placeholder="Value"
				@update="(v) => updateCondition({ value: v })"
			/>
		</div>

		<!-- Repeat: clone this block once per item in an array variable -->
		<div v-else-if="field.type === 'repeat'" class="flex flex-col gap-2">
			<div class="flex flex-col gap-[5px]">
				<FieldLabel>Array variable</FieldLabel>
				<TextField
					:value="repeat.variable ?? ''"
					placeholder="e.g. products"
					@update="(v) => updateRepeat({ variable: v })"
				/>
			</div>
			<div class="flex flex-col gap-[5px]">
				<FieldLabel>Item alias</FieldLabel>
				<TextField
					:value="repeat.itemAlias ?? ''"
					:placeholder="DEFAULT_ITEM_ALIAS"
					@update="(v) => updateRepeat({ itemAlias: v })"
				/>
				<p class="text-[11px] leading-[1.4] text-text-tertiary m-0">
					Reference each item with <code>{{ itemRefExample }}</code>.
				</p>
			</div>
			<div class="flex flex-col gap-[5px]">
				<FieldLabel>Max items</FieldLabel>
				<input
					type="number"
					min="1"
					step="1"
					class="w-full py-2 px-2.5 text-[13px] border border-border-subtle rounded-lg bg-bg-surface text-text-primary outline-none eb-input-ring placeholder:text-text-disabled appearance-number-plain"
					:value="repeat.maxItems ?? ''"
					placeholder="Unlimited"
					@input="(e) => updateRepeatMaxItems((e.target as HTMLInputElement).value)"
				/>
			</div>
		</div>

		<!-- Help text -->
		<p v-if="field.helpText" class="text-[11px] leading-[1.4] text-text-tertiary m-0">{{ field.helpText }}</p>
	</div>
</template>
