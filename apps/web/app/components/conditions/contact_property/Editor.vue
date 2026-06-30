<script setup lang="ts">
import { computed } from 'vue';
import type { ConditionOfKind, ConditionVariant } from '~/composables/conditions';
import { useConditionEditorContext } from '~/composables/conditions';
import {
	BUILT_IN_FIELDS,
	operatorsForField,
	operatorNeedsValue,
} from '~/composables/conditions/contact_property';

type ContactPropertyCondition = ConditionOfKind<'contact_property'>;

const props = defineProps<{
	modelValue: ContactPropertyCondition;
	variant: ConditionVariant;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: ContactPropertyCondition];
	save: [];
}>();

const ctx = useConditionEditorContext();

const operators = computed(() => operatorsForField(props.modelValue.field, ctx.contactProperties.value));
const needsValue = computed(() => operatorNeedsValue(props.modelValue.operator));

const updateField = (event: Event) => {
	const field = (event.target as HTMLSelectElement).value;
	const nextOperators = operatorsForField(field, ctx.contactProperties.value);
	const validOperator = nextOperators.some((o) => o.value === props.modelValue.operator)
		? props.modelValue.operator
		: nextOperators[0]?.value ?? 'equals';
	emit('update:modelValue', {
		...props.modelValue,
		field,
		operator: validOperator,
		value: '',
	});
	emit('save');
};

const updateOperator = (event: Event) => {
	const operator = (event.target as HTMLSelectElement).value as ContactPropertyCondition['operator'];
	emit('update:modelValue', { ...props.modelValue, operator });
	emit('save');
};

const updateValue = (event: Event) => {
	const value = (event.target as HTMLInputElement).value;
	emit('update:modelValue', { ...props.modelValue, value });
	emit('save');
};
</script>

<template>
	<!-- Row variant: compact, table-row layout for the segment editor modal -->
	<template v-if="variant === 'row'">
		<div>
			<label class="text-xs text-text-tertiary mb-1 block">Property</label>
			<select :value="modelValue.field" class="input" @change="updateField">
				<option value="">Select property...</option>
				<optgroup label="Built-in Fields">
					<option v-for="field in BUILT_IN_FIELDS" :key="field.value" :value="field.value">
						{{ field.label }}
					</option>
				</optgroup>
				<optgroup v-if="ctx.contactProperties.value.length" label="Custom Properties">
					<option v-for="prop in ctx.contactProperties.value" :key="prop.key" :value="prop.key">
						{{ prop.label }}
					</option>
				</optgroup>
			</select>
		</div>
		<div class="flex gap-3">
			<div class="flex-1">
				<label class="text-xs text-text-tertiary mb-1 block">Condition</label>
				<select :value="modelValue.operator" class="input" @change="updateOperator">
					<option v-for="op in operators" :key="op.value" :value="op.value">
						{{ op.label }}
					</option>
				</select>
			</div>
			<div v-if="needsValue" class="flex-1">
				<label class="text-xs text-text-tertiary mb-1 block">Value</label>
				<input
					:value="modelValue.value ?? ''"
					type="text"
					class="input"
					placeholder="Enter value..."
					@input="updateValue"
				/>
			</div>
		</div>
	</template>

	<!-- Panel variant: spacious layout for the automation condition step settings panel -->
	<template v-else>
		<div class="space-y-4">
			<div>
				<label for="conditionProperty" class="label">Property</label>
				<select
					id="conditionProperty"
					:value="modelValue.field"
					class="input mt-1.5"
					@change="updateField"
				>
					<option value="">Select a property...</option>
					<option v-for="field in BUILT_IN_FIELDS" :key="field.value" :value="field.value">
						{{ field.label }}
					</option>
					<option v-for="prop in ctx.contactProperties.value" :key="prop.key" :value="prop.key">
						{{ prop.label }}
					</option>
				</select>
			</div>

			<div>
				<label for="conditionOperator" class="label">Operator</label>
				<select
					id="conditionOperator"
					:value="modelValue.operator"
					class="input mt-1.5"
					@change="updateOperator"
				>
					<option v-for="op in operators" :key="op.value" :value="op.value">
						{{ op.label }}
					</option>
				</select>
			</div>

			<div v-if="needsValue">
				<label for="conditionValue" class="label">Value</label>
				<input
					id="conditionValue"
					:value="modelValue.value ?? ''"
					type="text"
					placeholder="Enter value to compare..."
					class="input mt-1.5"
					@blur="updateValue"
				/>
			</div>
		</div>
	</template>
</template>
