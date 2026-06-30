<script setup lang="ts">
import { computed } from 'vue';
import {
	CONDITION_EDITOR_MODULES,
	conditionEditorModuleFor,
	type Condition,
	type ConditionKind,
	type ConditionVariant,
	type ConditionOfKind,
} from '~/composables/conditions';

const props = defineProps<{
	modelValue: Condition;
	variant: ConditionVariant;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: Condition];
	save: [];
}>();

const module = computed(() => conditionEditorModuleFor(props.modelValue.kind));

const updateKind = (event: Event) => {
	const kind = (event.target as HTMLSelectElement).value as ConditionKind;
	emit('update:modelValue', CONDITION_EDITOR_MODULES[kind].createDefault({
		// Module's createDefault uses ctx only when it needs to seed from
		// available data; passing empty refs is safe — modules that need
		// data inject it themselves at editor render time.
		contactProperties: computed(() => []),
		topics: computed(() => []),
	} as never) as Condition);
	emit('save');
};

const onUpdate = (next: ConditionOfKind<ConditionKind>) => {
	emit('update:modelValue', next as Condition);
};
</script>

<template>
	<template v-if="variant === 'row'">
		<div>
			<label class="text-xs text-text-tertiary mb-1 block">Filter by</label>
			<select :value="modelValue.kind" class="input" @change="updateKind">
				<option
					v-for="m in Object.values(CONDITION_EDITOR_MODULES)"
					:key="m.kind"
					:value="m.kind"
				>
					{{ m.label }}
				</option>
			</select>
		</div>
		<component
			:is="module.EditorComponent"
			:model-value="modelValue"
			variant="row"
			@update:model-value="onUpdate"
			@save="emit('save')"
		/>
	</template>

	<template v-else>
		<div class="space-y-6">
			<div>
				<label class="label flex items-center gap-2 mb-2">
					<Icon name="lucide:git-branch" class="w-4 h-4 text-warning" />
					Condition Type
				</label>
				<select :value="modelValue.kind" class="input" @change="updateKind">
					<option
						v-for="m in Object.values(CONDITION_EDITOR_MODULES)"
						:key="m.kind"
						:value="m.kind"
					>
						{{ m.label }}
					</option>
				</select>
				<p class="text-xs text-text-tertiary mt-1.5">
					Choose what to evaluate for this condition.
				</p>
			</div>
			<component
				:is="module.EditorComponent"
				:model-value="modelValue"
				variant="panel"
				@update:model-value="onUpdate"
				@save="emit('save')"
			/>
		</div>
	</template>
</template>
