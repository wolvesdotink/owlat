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

const { t } = useI18n();

const stepLabel = (step: Doc<'automationSteps'>) =>
	step.stepType === 'email'
		? t('components.automations.steps.condition.editor.stepTypes.email')
		: step.stepType === 'delay'
			? t('components.automations.steps.condition.editor.stepTypes.delay')
			: t('components.automations.steps.condition.editor.stepTypes.condition');

const ctx = useConditionEditorContext();

const conditionDescription = computed(() => {
	const module = conditionEditorModuleFor(props.modelValue.condition.kind);
	// The condition registry returns a message key plus its interpolations —
	// module-scope definitions cannot call `useI18n`, so rendering translates.
	const described = (
		module.getDescription as unknown as (
			c: Condition,
			c2: ConditionEditorContext
		) => { key: string; params?: Record<string, unknown> }
	)(props.modelValue.condition, ctx);
	return t(described.key, described.params ?? {});
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
				{{ t('components.automations.steps.condition.editor.branchPaths') }}
			</p>

			<div class="space-y-4">
				<div class="p-4 bg-success/5 border border-success/20 rounded-lg">
					<div class="flex items-center gap-2 mb-2">
						<Icon name="lucide:check" class="w-4 h-4 text-success" />
						<span class="text-sm font-medium text-success">{{
							t('components.automations.steps.condition.editor.ifTrue')
						}}</span>
					</div>
					<select
						:value="modelValue.yesBranchStepIndex ?? ''"
						class="input"
						@change="updateYesBranch"
					>
						<option value="">
							{{ t('components.automations.steps.condition.editor.continueToNextStep') }}
						</option>
						<option
							v-for="(step, idx) in mutableSteps"
							:key="step._id"
							:value="idx"
							:disabled="idx === mutableSteps.findIndex((s) => s._id === selectedStepId)"
						>
							{{
								t('components.automations.steps.condition.editor.goToStep', {
									index: idx + 1,
									label: stepLabel(step),
								})
							}}
						</option>
					</select>
				</div>

				<div class="p-4 bg-error/5 border border-error/20 rounded-lg">
					<div class="flex items-center gap-2 mb-2">
						<Icon name="lucide:x" class="w-4 h-4 text-error" />
						<span class="text-sm font-medium text-error">{{
							t('components.automations.steps.condition.editor.ifFalse')
						}}</span>
					</div>
					<select
						:value="modelValue.noBranchStepIndex ?? ''"
						class="input"
						@change="updateNoBranch"
					>
						<option value="">
							{{ t('components.automations.steps.condition.editor.continueToNextStep') }}
						</option>
						<option
							v-for="(step, idx) in mutableSteps"
							:key="step._id"
							:value="idx"
							:disabled="idx === mutableSteps.findIndex((s) => s._id === selectedStepId)"
						>
							{{
								t('components.automations.steps.condition.editor.goToStep', {
									index: idx + 1,
									label: stepLabel(step),
								})
							}}
						</option>
					</select>
				</div>
			</div>
			<p class="text-xs text-text-tertiary mt-2">
				{{ t('components.automations.steps.condition.editor.branchHint') }}
			</p>
		</div>

		<div class="p-4 bg-bg-surface border border-border-subtle rounded-lg">
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-3">
				{{ t('components.automations.steps.condition.editor.previewTitle') }}
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
