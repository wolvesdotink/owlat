<script setup lang="ts">
/**
 * The trigger choice on the new-automation page: one pressed-state card per
 * trigger kind in the editor module registry, and the form's error when none
 * is chosen. Choosing one resets its configuration, which the page owns.
 */
import { listTriggerEditorModules, type TriggerKind } from '~/composables/automations/triggers';
import { CheckIcon, ZapIcon } from '@coolicons/vue';

defineProps<{
	/** The chosen trigger kind, or null before one is picked. */
	modelValue: TriggerKind | null;
	error?: string;
}>();

const emit = defineEmits<{ select: [kind: TriggerKind] }>();

const { t } = useI18n();

// Trigger type catalog — derived from the editor module registry.
const triggerTypes = computed(() =>
	listTriggerEditorModules().map((m) => ({
		id: m.kind,
		label: m.label,
		description: m.description,
		icon: m.icon,
		color: m.color,
		requiresConfig: m.requiresConfig,
	}))
);

// Get color class for trigger type
const getTriggerColorClass = (color: string, selected: boolean) => {
	if (selected) {
		switch (color) {
			case 'lime':
				return 'border-brand bg-brand/5';
			case 'lavender':
				return 'border-brand bg-brand/5';
			case 'warning':
				return 'border-warning bg-warning/5';
			case 'success':
				return 'border-success bg-success/5';
			default:
				return 'border-brand bg-brand/5';
		}
	}
	return 'border-border-subtle hover:border-border-default';
};

// Get icon color class
const getIconColorClass = (color: string) => {
	switch (color) {
		case 'lime':
			return 'text-brand bg-brand/10';
		case 'lavender':
			return 'text-brand bg-brand/10';
		case 'warning':
			return 'text-warning bg-warning/10';
		case 'success':
			return 'text-success bg-success/10';
		default:
			return 'text-brand bg-brand/10';
	}
};
</script>

<template>
	<div>
		<p id="automation-trigger-type-label" class="label flex items-center gap-2 mb-3">
			<ZapIcon class="w-4 h-4 text-text-tertiary" />
			{{ t('dashboard.automations.new.form.triggerTypeLabel') }}
			<span class="text-error" aria-hidden="true">*</span>
		</p>

		<!-- Trigger Options Grid -->
		<div
			role="group"
			aria-labelledby="automation-trigger-type-label"
			class="grid grid-cols-1 sm:grid-cols-2 gap-4"
		>
			<button
				v-for="trigger in triggerTypes"
				:key="trigger.id"
				type="button"
				:aria-pressed="modelValue === trigger.id"
				:class="[
					'flex items-start gap-4 p-4 border rounded-lg text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
					getTriggerColorClass(trigger.color, modelValue === trigger.id),
				]"
				@click="emit('select', trigger.id)"
			>
				<!-- Icon -->
				<div
					:class="[
						'p-3 rounded-lg shrink-0 flex items-center justify-center',
						getIconColorClass(trigger.color),
					]"
				>
					<component :is="trigger.icon" class="w-5 h-5" />
				</div>
				<!-- Content -->
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2">
						<span class="font-medium text-text-primary">{{ t(trigger.label) }}</span>
						<CheckIcon v-if="modelValue === trigger.id" class="w-4 h-4 text-brand" />
					</div>
					<p class="text-sm text-text-secondary mt-1">
						{{ t(trigger.description) }}
					</p>
				</div>
			</button>
		</div>

		<p v-if="error" class="mt-3 text-sm text-error">
			{{ error }}
		</p>
	</div>
</template>
