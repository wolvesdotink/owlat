<script setup lang="ts">
import { computed } from 'vue';
import type { PropertyField as PropertyFieldType } from '../../schema/types';
import type {
	BlockCondition,
	BlockRepeat,
	EditorBlock,
	Variable,
	EmailTheme,
	GradientBackground,
	ImageUploadResult,
} from '../../types';

// Field sub-components
import ColorField from './fields/ColorField.vue';
import NumberField from './fields/NumberField.vue';
import SliderField from './fields/SliderField.vue';
import AlignField from './fields/AlignField.vue';
import ImageField from './fields/ImageField.vue';
import ToggleField from './fields/ToggleField.vue';
import SelectField from './fields/SelectField.vue';
import TextField from './fields/TextField.vue';
import AltTextField from './fields/AltTextField.vue';

// Complex editors
import RichTextEditor from './RichTextEditor.vue';
import ArrayEditor from './ArrayEditor.vue';
import BoxSidesEditor from './BoxSidesEditor.vue';
import BorderEditor from './BorderEditor.vue';
import GradientEditor from './GradientEditor.vue';

// Shared UI
import FieldLabel from '../ui/FieldLabel.vue';

import {
	type ConditionOperator,
	conditionOperatorOptions,
	conditionNeedsValue as operatorNeedsValue,
	normalizeCondition,
	DEFAULT_CONDITION_OPERATOR,
} from '../../utils/blockCondition';
import { normalizeRepeat, DEFAULT_ITEM_ALIAS } from '../../utils/blockRepeat';
import {
	mediaAssetIdentityKeyForImageSource,
	storageIdentityKeyForImageSource,
} from '../../utils/imageStorage';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t, label } = useBuilderI18n();

const props = defineProps<{
	field: PropertyFieldType;
	value: unknown;
	block: EditorBlock;
	theme: Required<EmailTheme>;
	variables?: Variable[];
}>();

const emit = defineEmits<{
	(e: 'update', value: unknown): void;
	(e: 'update-keyed', key: string, value: unknown): void;
}>();

const stringValue = computed(() => (props.value as string) ?? '');
/** `decorative` lives next to the alt field on the same block content. */
const isDecorative = computed(
	() => (props.block.content as { decorative?: boolean }).decorative === true
);
const numberValue = computed(() => (props.value as number) ?? 0);
const booleanValue = computed(() => (props.value as boolean) ?? false);

function updateImageUrl(value: string) {
	emit('update', value);
	const storageIdentityKey = storageIdentityKeyForImageSource(props.field.key);
	if (storageIdentityKey) {
		emit('update-keyed', storageIdentityKey, undefined);
	}
	const mediaAssetIdentityKey = mediaAssetIdentityKeyForImageSource(props.field.key);
	if (mediaAssetIdentityKey) emit('update-keyed', mediaAssetIdentityKey, undefined);
}

function selectStoredImage(result: ImageUploadResult) {
	emit('update', result.url);
	const storageIdentityKey = storageIdentityKeyForImageSource(props.field.key);
	if (storageIdentityKey) {
		emit('update-keyed', storageIdentityKey, result.storageId);
	}
	const mediaAssetIdentityKey = mediaAssetIdentityKeyForImageSource(props.field.key);
	if (mediaAssetIdentityKey) emit('update-keyed', mediaAssetIdentityKey, result.mediaAssetId);
}

// Condition editor ----------------------------------------------------------
const condition = computed(() => (props.value as Partial<BlockCondition> | undefined) ?? {});
const conditionOperator = computed<ConditionOperator>(
	() => condition.value.operator ?? DEFAULT_CONDITION_OPERATOR
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

// Schema copy is English registry metadata, translated here where it is shown.
const fieldLabel = computed(() => label(props.field.label));
const fieldPlaceholder = computed(() =>
	props.field.placeholder === undefined ? undefined : label(props.field.placeholder)
);
const fieldOptions = computed(() =>
	(props.field.options ?? []).map((option) => ({ ...option, label: label(option.label) }))
);
const operatorOptions = computed(() =>
	conditionOperatorOptions.map((option) => ({ ...option, label: label(option.label) }))
);

const fontFamilyOptions = computed(() => [
	{ label: t('builder.panel.fontDefault'), value: '' },
	{ label: 'Arial', value: 'Arial, sans-serif' },
	{ label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
	{ label: 'Georgia', value: 'Georgia, serif' },
	{ label: 'Times New Roman', value: "'Times New Roman', Times, serif" },
	{ label: 'Courier New', value: "'Courier New', Courier, monospace" },
	{ label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
	{ label: 'Trebuchet MS', value: "'Trebuchet MS', sans-serif" },
	{ label: 'Tahoma', value: 'Tahoma, Geneva, sans-serif' },
]);
</script>

<template>
	<div
		class="flex flex-col gap-[5px]"
		:class="{ 'flex-row items-center justify-between gap-3 min-h-[34px]': isInlineLayout }"
	>
		<!-- Label: always shown except for toggle (which has its own label) -->
		<FieldLabel v-if="field.type !== 'toggle'" :class="{ 'shrink-0 min-w-0': isInlineLayout }">
			{{ fieldLabel }}
		</FieldLabel>

		<!-- Toggle (uses its own inline label) -->
		<ToggleField
			v-if="field.type === 'toggle'"
			:value="booleanValue"
			:label="fieldLabel"
			@update="(val) => emit('update', val)"
		/>

		<!-- Text input -->
		<TextField
			v-else-if="field.type === 'text'"
			:value="stringValue"
			:label="fieldLabel"
			:placeholder="fieldPlaceholder"
			@update="(val) => emit('update', val)"
		/>

		<!-- Alt text: plain text input plus the missing-alt accessibility nudge -->
		<AltTextField
			v-else-if="field.type === 'altText'"
			:value="stringValue"
			:decorative="isDecorative"
			:placeholder="fieldPlaceholder"
			@update="(val) => emit('update', val)"
			@mark-decorative="emit('update-keyed', 'decorative', true)"
		/>

		<!-- Textarea -->
		<textarea
			v-else-if="field.type === 'textarea'"
			:aria-label="fieldLabel"
			class="w-full py-2 px-2.5 text-xs font-mono border border-border-subtle rounded-lg bg-bg-surface text-text-primary resize-y outline-none eb-input-ring"
			:value="stringValue"
			:placeholder="fieldPlaceholder"
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
			:label="fieldLabel"
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
			:label="fieldLabel"
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
			:label="fieldLabel"
			:placeholder="fieldPlaceholder"
			@update="(val) => emit('update', val)"
		/>

		<!-- Select dropdown -->
		<SelectField
			v-else-if="field.type === 'select'"
			:value="value"
			:label="fieldLabel"
			:options="fieldOptions"
			@update="(val) => emit('update', val)"
		/>

		<!-- URL input -->
		<TextField
			v-else-if="field.type === 'url'"
			:value="stringValue"
			:label="fieldLabel"
			:placeholder="fieldPlaceholder ?? 'https://'"
			type="url"
			@update="(val) => emit('update', val)"
		/>

		<!-- Date input -->
		<input
			v-else-if="field.type === 'date'"
			type="datetime-local"
			:aria-label="fieldLabel"
			class="w-full py-2 px-2.5 text-[13px] border border-border-subtle rounded-lg bg-bg-surface text-text-primary outline-none eb-input-ring"
			:value="stringValue ? stringValue.slice(0, 16) : ''"
			@input="(e) => emit('update', new Date((e.target as HTMLInputElement).value).toISOString())"
		/>

		<!-- Image upload -->
		<ImageField
			v-else-if="field.type === 'image'"
			:value="stringValue"
			@update="updateImageUrl"
			@select="selectStoredImage"
		/>

		<!-- Alignment selector -->
		<AlignField
			v-else-if="field.type === 'align'"
			:value="stringValue"
			:options="field.alignOptions"
			@update="(val) => emit('update', val)"
		/>

		<!-- Padding editor -->
		<BoxSidesEditor
			v-else-if="field.type === 'spacing'"
			:block="block"
			prefix="padding"
			:modes="['uniform', 'axis', 'individual']"
			@update="(key, val) => $emit('update-keyed', key, val)"
		/>

		<!-- Margin editor -->
		<BoxSidesEditor
			v-else-if="field.type === 'margin'"
			:block="block"
			prefix="margin"
			:modes="['axis', 'individual']"
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
			:model-value="value as GradientBackground | undefined"
			@update:model-value="(val) => emit('update', val)"
		/>

		<!-- Font family -->
		<SelectField
			v-else-if="field.type === 'fontFamily'"
			:value="stringValue"
			:label="fieldLabel"
			:options="fontFamilyOptions"
			:placeholder="t('builder.panel.fontDefault')"
			@update="(val) => emit('update', val)"
		/>

		<!-- Array editor -->
		<ArrayEditor
			v-else-if="field.type === 'array'"
			:field="field"
			:value="value as unknown[]"
			@update="(val) => emit('update', val)"
		/>

		<!-- Condition: show/hide the block based on a variable -->
		<div v-else-if="field.type === 'condition'" class="flex flex-col gap-[5px]">
			<TextField
				:label="t('builder.panel.condition.variable')"
				:value="condition.variable ?? ''"
				:placeholder="t('builder.panel.condition.variablePlaceholder')"
				@update="(v) => updateCondition({ variable: v })"
			/>
			<SelectField
				:label="t('builder.panel.condition.operator')"
				:value="conditionOperator"
				:options="operatorOptions"
				@update="(v) => updateCondition({ operator: v as ConditionOperator })"
			/>
			<TextField
				v-if="conditionNeedsValue"
				:label="t('builder.panel.condition.value')"
				:value="condition.value ?? ''"
				:placeholder="t('builder.panel.condition.valuePlaceholder')"
				@update="(v) => updateCondition({ value: v })"
			/>
		</div>

		<!-- Repeat: clone this block once per item in an array variable -->
		<div v-else-if="field.type === 'repeat'" class="flex flex-col gap-2">
			<div class="flex flex-col gap-[5px]">
				<FieldLabel>{{ t('builder.panel.repeat.arrayVariable') }}</FieldLabel>
				<TextField
					:label="t('builder.panel.repeat.variable')"
					:value="repeat.variable ?? ''"
					:placeholder="t('builder.panel.repeat.variablePlaceholder')"
					@update="(v) => updateRepeat({ variable: v })"
				/>
			</div>
			<div class="flex flex-col gap-[5px]">
				<FieldLabel>{{ t('builder.panel.repeat.itemAlias') }}</FieldLabel>
				<TextField
					:label="t('builder.panel.repeat.itemAlias')"
					:value="repeat.itemAlias ?? ''"
					:placeholder="DEFAULT_ITEM_ALIAS"
					@update="(v) => updateRepeat({ itemAlias: v })"
				/>
				<p class="text-[11px] leading-[1.4] text-text-tertiary m-0">
					{{ t('builder.panel.repeat.referenceBefore') }}
					<code>{{ itemRefExample }}</code
					>{{ t('builder.panel.repeat.referenceAfter') }}
				</p>
			</div>
			<div class="flex flex-col gap-[5px]">
				<FieldLabel>{{ t('builder.panel.repeat.maxItems') }}</FieldLabel>
				<input
					type="number"
					:aria-label="t('builder.panel.repeat.maxItems')"
					min="1"
					step="1"
					class="w-full py-2 px-2.5 text-[13px] border border-border-subtle rounded-lg bg-bg-surface text-text-primary outline-none eb-input-ring placeholder:text-text-disabled appearance-number-plain"
					:value="repeat.maxItems ?? ''"
					:placeholder="t('builder.panel.repeat.unlimited')"
					@input="(e) => updateRepeatMaxItems((e.target as HTMLInputElement).value)"
				/>
			</div>
		</div>

		<!-- Help text -->
		<p v-if="field.helpText" class="text-[11px] leading-[1.4] text-text-tertiary m-0">
			{{ label(field.helpText) }}
		</p>
	</div>
</template>
