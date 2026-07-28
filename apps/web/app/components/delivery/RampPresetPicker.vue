<script setup lang="ts">
/**
 * PER-STREAM AGGRESSIVENESS (plan D9, D14).
 *
 * NONE OF THE THREE IS LABELLED "RECOMMENDED". Each is described by what it
 * costs and what it buys, and the deployment's default is stated separately as a
 * fact — a standalone install defaults to Conservative because its engagement
 * signal is genuinely the weaker one, which is a statement about evidence rather
 * than about nerve, and the copy says exactly that.
 *
 * "Use the default" is a real, selectable option rather than an absence: it
 * deletes the stored row, so a deployment that later connects a relay picks up
 * the new default automatically instead of silently keeping a pace it never
 * chose.
 */
import type { RampPreset } from '@owlat/shared/deliverabilityIndependence';
import { RAMP_PRESET_OPTIONS, STREAM_LABELS } from '~/utils/deliverabilityRamp';

const props = defineProps<{
	stream: string;
	/** The stored choice, or `null` when the stream is on the default. */
	preset: RampPreset | null;
	defaultPreset: RampPreset;
	busy?: boolean;
}>();

const emit = defineEmits<{ change: [preset: RampPreset | null] }>();

const groupId = useId();
const defaultLabel = computed(
	() => RAMP_PRESET_OPTIONS.find((option) => option.value === props.defaultPreset)?.label ?? ''
);
</script>

<template>
	<fieldset class="space-y-2" :data-testid="`ramp-preset-${stream}`">
		<legend :id="groupId" class="text-sm font-medium text-text-primary">
			{{ STREAM_LABELS[stream] ?? stream }} mail
		</legend>
		<p class="text-xs text-text-secondary">Default for this deployment: {{ defaultLabel }}.</p>
		<div class="space-y-1">
			<label class="flex items-start gap-2 text-sm">
				<input
					type="radio"
					:name="`preset-${stream}`"
					:checked="preset === null"
					:disabled="busy === true"
					data-testid="ramp-preset-default"
					@change="emit('change', null)"
				/>
				<span>
					<span class="text-text-primary">Use the default</span>
					<span class="block text-xs text-text-secondary">
						Follows the deployment default, including if that changes later.
					</span>
				</span>
			</label>
			<label
				v-for="option in RAMP_PRESET_OPTIONS"
				:key="option.value"
				class="flex items-start gap-2 text-sm"
			>
				<input
					type="radio"
					:name="`preset-${stream}`"
					:checked="preset === option.value"
					:disabled="busy === true"
					:data-testid="`ramp-preset-option-${option.value}`"
					@change="emit('change', option.value)"
				/>
				<span>
					<span class="text-text-primary">{{ option.label }}</span>
					<span class="block text-xs text-text-secondary">{{ option.description }}</span>
				</span>
			</label>
		</div>
	</fieldset>
</template>
