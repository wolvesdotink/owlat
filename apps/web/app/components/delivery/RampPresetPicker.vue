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
 * SAY THE QUIET PART (plan D14). On a standalone deployment the two faster
 * paces run the reference-arm constants with no reference arm to corroborate
 * them, so each of them carries the sentence that says so. They stay selectable
 * — this is an operator's deployment and the trade-off is theirs to take — but
 * it is stated rather than discovered.
 *
 * "Use the default" is a real, selectable option rather than an absence: it
 * deletes the stored row, so a deployment that later connects a relay picks up
 * the new default automatically instead of silently keeping a pace it never
 * chose.
 */
import type { RampPreset } from '@owlat/shared/deliverabilityIndependence';
import type { DeliverabilityStream } from '@owlat/shared/deliverabilityRouting';
import { RAMP_PRESET_OPTIONS, streamLabel } from '~/utils/deliverabilityRamp';

const props = defineProps<{
	// The closed stream union, not `string`: a typo in a caller's stream name is a
	// build failure rather than a legend reading "campain mail".
	stream: DeliverabilityStream;
	/** The stored choice, or `null` when the stream is on the default. */
	preset: RampPreset | null;
	defaultPreset: RampPreset;
	/**
	 * Whether the deployment has a reference arm configured. Stated by the view
	 * object the parent renders from (`RampControlsView.referenceTransportId`)
	 * rather than inferred from the pace, so the D14 copy below depends on the
	 * fact instead of on a constant that happens to correlate with it.
	 */
	hasReferenceArm: boolean;
	busy?: boolean;
}>();

const emit = defineEmits<{ change: [preset: RampPreset | null] }>();

const defaultLabel = computed(
	() => RAMP_PRESET_OPTIONS.find((option) => option.value === props.defaultPreset)?.label ?? ''
);
const isStandalone = computed(() => !props.hasReferenceArm);
</script>

<template>
	<fieldset class="space-y-2" :data-testid="`ramp-preset-${stream}`">
		<legend class="text-sm font-medium text-text-primary">{{ streamLabel(stream) }} mail</legend>
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
					<span
						v-if="isStandalone && option.value !== 'conservative'"
						class="block text-xs text-text-secondary"
						:data-testid="`ramp-preset-standalone-note-${option.value}`"
					>
						With no relay connected the engagement check is the weaker signal, so this pace advances
						on evidence nothing else has corroborated.
					</span>
				</span>
			</label>
		</div>
	</fieldset>
</template>
