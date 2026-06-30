<script setup lang="ts">
import { computed } from 'vue';
import type { DelayStepConfig } from '~/composables/automations/steps';
import { delayUnitLabel } from '~/composables/automations/steps/delay';

type Unit = DelayStepConfig['unit'];

const props = defineProps<{
	modelValue: DelayStepConfig;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: DelayStepConfig];
	save: [];
}>();

const updateDuration = (event: Event) => {
	const duration = Number((event.target as HTMLInputElement).value);
	emit('update:modelValue', { ...props.modelValue, duration });
	emit('save');
};

const updateUnit = (event: Event) => {
	const unit = (event.target as HTMLSelectElement).value as Unit;
	emit('update:modelValue', { ...props.modelValue, unit });
	emit('save');
};

const applyPreset = (duration: number, unit: Unit) => {
	emit('update:modelValue', { duration, unit });
	emit('save');
};

const unitLabel = computed(() => delayUnitLabel(props.modelValue.duration, props.modelValue.unit));

const presets: { duration: number; unit: Unit; label: string }[] = [
	{ duration: 30, unit: 'minutes', label: '30 min' },
	{ duration: 1, unit: 'hours', label: '1 hour' },
	{ duration: 24, unit: 'hours', label: '24 hours' },
	{ duration: 1, unit: 'days', label: '1 day' },
	{ duration: 3, unit: 'days', label: '3 days' },
	{ duration: 1, unit: 'weeks', label: '1 week' },
	{ duration: 2, unit: 'weeks', label: '2 weeks' },
];
</script>

<template>
	<div class="space-y-6">
		<div>
			<label class="label flex items-center gap-2 mb-2">
				<Icon name="lucide:clock" class="w-4 h-4 text-brand" />
				Delay Duration
			</label>
			<div class="flex gap-3">
				<input
					:value="modelValue.duration"
					type="number"
					min="1"
					class="input w-24"
					@change="updateDuration"
				/>
				<select :value="modelValue.unit" class="input flex-1" @change="updateUnit">
					<option value="minutes">Minutes</option>
					<option value="hours">Hours</option>
					<option value="days">Days</option>
					<option value="weeks">Weeks</option>
				</select>
			</div>
			<p class="text-xs text-text-tertiary mt-1.5">
				How long to wait before proceeding to the next step.
			</p>
		</div>

		<div>
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-2">
				Quick Presets
			</p>
			<div class="flex flex-wrap gap-2">
				<button
					v-for="preset in presets"
					:key="preset.label"
					class="px-3 py-1.5 text-sm rounded-lg border transition-colors"
					:class="
						modelValue.duration === preset.duration && modelValue.unit === preset.unit
							? 'bg-brand/10 border-brand text-brand'
							: 'bg-bg-surface border-border-subtle text-text-secondary hover:border-border-default'
					"
					@click="applyPreset(preset.duration, preset.unit)"
				>
					{{ preset.label }}
				</button>
			</div>
		</div>

		<div class="p-4 bg-bg-surface border border-border-subtle rounded-lg">
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-3">
				Duration Preview
			</p>
			<div class="flex items-center justify-center">
				<div
					class="inline-flex items-center gap-2 px-4 py-2 bg-brand/10 border border-brand/30 rounded-full"
				>
					<Icon name="lucide:clock" class="w-4 h-4 text-brand" />
					<span class="text-base font-medium text-brand">
						{{ modelValue.duration }} {{ unitLabel }}
					</span>
				</div>
			</div>
			<p class="text-xs text-text-tertiary text-center mt-2">
				This is how the delay will appear in the workflow
			</p>
		</div>
	</div>
</template>
