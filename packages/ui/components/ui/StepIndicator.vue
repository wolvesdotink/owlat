<script setup lang="ts">
type StepStatus = 'completed' | 'current' | 'upcoming';

interface Step {
	id: string;
	label: string;
	number: number;
}

interface Props {
	steps: Step[];
	getStepStatus: (stepId: Step['id']) => StepStatus;
	isConnectorHighlighted: (index: number) => boolean;
}

defineProps<Props>();
</script>

<template>
	<nav aria-label="Progress">
		<ol class="flex items-center justify-between">
			<li
				v-for="(step, index) in steps"
				:key="step.id"
				class="flex items-center"
				:class="index < steps.length - 1 ? 'flex-1' : ''"
			>
				<div class="flex items-center">
					<!-- Step Circle -->
					<div
						:class="[
							'flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium transition-colors',
							getStepStatus(step.id) === 'completed'
								? 'bg-brand text-text-inverse'
								: getStepStatus(step.id) === 'current'
									? 'bg-brand/20 text-brand border-2 border-brand'
									: 'bg-bg-surface text-text-tertiary border border-border-subtle',
						]"
					>
						<Icon v-if="getStepStatus(step.id) === 'completed'" name="lucide:check" class="w-4 h-4" />
						<span v-else>{{ step.number }}</span>
					</div>
					<!-- Step Label -->
					<span
						:class="[
							'ml-3 text-sm font-medium',
							getStepStatus(step.id) === 'completed'
								? 'text-brand'
								: getStepStatus(step.id) === 'current'
									? 'text-text-primary'
									: 'text-text-tertiary',
						]"
					>
						{{ step.label }}
					</span>
				</div>
				<!-- Connector Line -->
				<div
					v-if="index < steps.length - 1"
					:class="[
						'flex-1 h-0.5 mx-4',
						isConnectorHighlighted(index) ? 'bg-brand/30' : 'bg-border-subtle',
					]"
				/>
			</li>
		</ol>
	</nav>
</template>
