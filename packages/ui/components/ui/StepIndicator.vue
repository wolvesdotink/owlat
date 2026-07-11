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
	/**
	 * Optional. When provided, a *completed* step becomes a button that calls this
	 * with the step id, letting the user jump back. Omitted ⇒ the indicator stays
	 * a passive read-out (current behaviour for every other caller).
	 */
	onStepClick?: (stepId: Step['id']) => void;
}

const props = defineProps<Props>();

function stepIsClickable(stepId: Step['id']): boolean {
	return !!props.onStepClick && props.getStepStatus(stepId) === 'completed';
}

function handleStepClick(stepId: Step['id']): void {
	if (stepIsClickable(stepId)) props.onStepClick?.(stepId);
}
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
				<component
					:is="stepIsClickable(step.id) ? 'button' : 'div'"
					:type="stepIsClickable(step.id) ? 'button' : undefined"
					class="flex items-center rounded-md text-left"
					:class="
						stepIsClickable(step.id)
							? 'cursor-pointer transition-opacity duration-(--motion-fast) hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'
							: ''
					"
					:aria-label="stepIsClickable(step.id) ? `Go back to ${step.label}` : undefined"
					@click="handleStepClick(step.id)"
				>
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
						<Icon
							v-if="getStepStatus(step.id) === 'completed'"
							name="lucide:check"
							class="w-4 h-4"
						/>
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
				</component>
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
