<script setup lang="ts">
import type { Doc } from '@owlat/api/dataModel';
import type { Condition, ConditionEditorContext } from '~/composables/conditions';
import { conditionEditorModuleFor } from '~/composables/conditions';
import { useConditionEditorContext } from '~/composables/conditions';
import type { ConditionStepConfig } from '~/composables/automations/steps';

const props = defineProps<{
	modelValue: ConditionStepConfig;
	mutableSteps: Doc<'automationSteps'>[];
	selectedStepId: string | null;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: ConditionStepConfig];
	save: [];
}>();

const updateCondition = (condition: Condition) => {
	emit('update:modelValue', { ...props.modelValue, condition });
	emit('save');
};

const updateYesBranch = (event: Event) => {
	const raw = (event.target as HTMLSelectElement).value;
	emit('update:modelValue', {
		...props.modelValue,
		yesBranchStepIndex: raw === '' ? null : Number(raw),
	});
	emit('save');
};

const updateNoBranch = (event: Event) => {
	const raw = (event.target as HTMLSelectElement).value;
	emit('update:modelValue', {
		...props.modelValue,
		noBranchStepIndex: raw === '' ? null : Number(raw),
	});
	emit('save');
};

const stepLabel = (step: Doc<'automationSteps'>) =>
	step.stepType === 'email'
		? 'Send Email'
		: step.stepType === 'delay'
			? 'Wait/Delay'
			: 'Condition';

const ctx = useConditionEditorContext();

const conditionDescription = computed(() => {
	const module = conditionEditorModuleFor(props.modelValue.condition.kind);
	return (
		module.getDescription as (c: Condition, c2: ConditionEditorContext) => string
	)(props.modelValue.condition, ctx);
});
</script>

<template>
	<div class="space-y-6">
		<ConditionsConditionEditor
			:model-value="modelValue.condition"
			variant="panel"
			@update:model-value="updateCondition"
			@save="emit('save')"
		/>

		<!-- Branch Targets -->
		<div class="pt-4 border-t border-border-subtle">
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-3">
				Branch Paths
			</p>

			<div class="space-y-4">
				<div class="p-4 bg-success/5 border border-success/20 rounded-lg">
					<div class="flex items-center gap-2 mb-2">
						<Icon name="lucide:check" class="w-4 h-4 text-success" />
						<span class="text-sm font-medium text-success">If condition is TRUE</span>
					</div>
					<select
						:value="modelValue.yesBranchStepIndex ?? ''"
						class="input"
						@change="updateYesBranch"
					>
						<option value="">Continue to next step</option>
						<option
							v-for="(step, idx) in mutableSteps"
							:key="step._id"
							:value="idx"
							:disabled="idx === mutableSteps.findIndex((s) => s._id === selectedStepId)"
						>
							Go to Step {{ idx + 1 }}: {{ stepLabel(step) }}
						</option>
					</select>
				</div>

				<div class="p-4 bg-error/5 border border-error/20 rounded-lg">
					<div class="flex items-center gap-2 mb-2">
						<Icon name="lucide:x" class="w-4 h-4 text-error" />
						<span class="text-sm font-medium text-error">If condition is FALSE</span>
					</div>
					<select
						:value="modelValue.noBranchStepIndex ?? ''"
						class="input"
						@change="updateNoBranch"
					>
						<option value="">Continue to next step</option>
						<option
							v-for="(step, idx) in mutableSteps"
							:key="step._id"
							:value="idx"
							:disabled="idx === mutableSteps.findIndex((s) => s._id === selectedStepId)"
						>
							Go to Step {{ idx + 1 }}: {{ stepLabel(step) }}
						</option>
					</select>
				</div>
			</div>
			<p class="text-xs text-text-tertiary mt-2">
				Choose where the workflow should go based on the condition result.
			</p>
		</div>

		<div class="p-4 bg-bg-surface border border-border-subtle rounded-lg">
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-3">
				Condition Preview
			</p>
			<div class="flex items-center justify-center">
				<div
					class="inline-flex items-center gap-2 px-4 py-2 bg-warning/10 border border-warning/30 rounded-full"
				>
					<Icon name="lucide:git-branch" class="w-4 h-4 text-warning" />
					<span class="text-base font-medium text-warning">{{ conditionDescription }}</span>
				</div>
			</div>
		</div>
	</div>
</template>
