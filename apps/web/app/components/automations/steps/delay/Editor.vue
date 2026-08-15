<script setup lang="ts">
import { computed } from 'vue';
import type { DelayStepConfig } from '~/composables/automations/steps';

type Unit = DelayStepConfig['unit'];

const { t } = useI18n();

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

const durationPreview = computed(() =>
	t(
		`components.automations.steps.delay.editor.preview.${props.modelValue.unit}`,
		{ count: props.modelValue.duration },
		props.modelValue.duration
	)
);

const presetKey = (name: string) => `components.automations.steps.delay.editor.presets.${name}`;

const presets: { duration: number; unit: Unit; labelKey: string }[] = [
	{ duration: 30, unit: 'minutes', labelKey: presetKey('minutes30') },
	{ duration: 1, unit: 'hours', labelKey: presetKey('hours1') },
	{ duration: 24, unit: 'hours', labelKey: presetKey('hours24') },
	{ duration: 1, unit: 'days', labelKey: presetKey('days1') },
	{ duration: 3, unit: 'days', labelKey: presetKey('days3') },
	{ duration: 1, unit: 'weeks', labelKey: presetKey('weeks1') },
	{ duration: 2, unit: 'weeks', labelKey: presetKey('weeks2') },
];
</script>

<template>
	<div class="space-y-6">
		<div>
			<label class="label flex items-center gap-2 mb-2">
				<Icon name="lucide:clock" class="w-4 h-4 text-brand" />
				{{ t('components.automations.steps.delay.editor.durationLabel') }}
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
					<option value="minutes">
						{{ t('components.automations.steps.delay.editor.unitOptions.minutes') }}
					</option>
					<option value="hours">
						{{ t('components.automations.steps.delay.editor.unitOptions.hours') }}
					</option>
					<option value="days">
						{{ t('components.automations.steps.delay.editor.unitOptions.days') }}
					</option>
					<option value="weeks">
						{{ t('components.automations.steps.delay.editor.unitOptions.weeks') }}
					</option>
				</select>
			</div>
			<p class="text-xs text-text-tertiary mt-1.5">
				{{ t('components.automations.steps.delay.editor.durationHint') }}
			</p>
		</div>

		<div>
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-2">
				{{ t('components.automations.steps.delay.editor.presetsLabel') }}
			</p>
			<div class="flex flex-wrap gap-2">
				<button
					v-for="preset in presets"
					:key="preset.labelKey"
					class="px-3 py-1.5 text-sm rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					:class="
						modelValue.duration === preset.duration && modelValue.unit === preset.unit
							? 'bg-brand/10 border-brand text-brand'
							: 'bg-bg-surface border-border-subtle text-text-secondary hover:border-border-default'
					"
					@click="applyPreset(preset.duration, preset.unit)"
				>
					{{ t(preset.labelKey) }}
				</button>
			</div>
		</div>

		<div class="p-4 bg-bg-surface shadow-surface-1 rounded-lg">
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-3">
				{{ t('components.automations.steps.delay.editor.previewLabel') }}
			</p>
			<div class="flex items-center justify-center">
				<div
					class="inline-flex items-center gap-2 px-4 py-2 bg-brand/10 border border-brand/30 rounded-full"
				>
					<Icon name="lucide:clock" class="w-4 h-4 text-brand" />
					<span class="text-base font-medium text-brand">
						{{ durationPreview }}
					</span>
				</div>
			</div>
			<p class="text-xs text-text-tertiary text-center mt-2">
				{{ t('components.automations.steps.delay.editor.previewHint') }}
			</p>
		</div>
	</div>
</template>
