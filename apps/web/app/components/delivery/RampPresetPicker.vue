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

const { t } = useI18n();

/**
 * `RAMP_PRESET_OPTIONS` and the stream vocabulary are module-scope definitions,
 * so they carry i18n keys rather than sentences (the registry convention); a
 * plain string is still accepted so a value with nothing to translate reads as
 * itself.
 */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

const defaultLabel = computed(() => {
	const option = RAMP_PRESET_OPTIONS.find((entry) => entry.value === props.defaultPreset);
	return option ? localized(option.label) : '';
});
const isStandalone = computed(() => !props.hasReferenceArm);

/** The DOM value for "no stored row" — `null` is not an attribute value. */
const DEFAULT_VALUE = 'default';

function radioValue(preset: RampPreset | null): string {
	return preset ?? DEFAULT_VALUE;
}

const group = ref<HTMLFieldSetElement | null>(null);

/**
 * THE STORED PRESET IS THE ONLY TRUTH ON SCREEN — once the write has answered.
 *
 * A click moves the radio in the DOM before anything is saved, and `:checked`
 * cannot move it back: the bound value never changed, so Vue has nothing to
 * patch. A `setStreamPreset` that is refused or fails therefore left the group
 * showing a pace nobody is on — the one reading an operator will act on.
 */
function syncFromProp(): void {
	const root = group.value;
	if (root === null) return;
	const stored = radioValue(props.preset);
	for (const input of root.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
		input.checked = input.value === stored;
	}
}

/**
 * THE CORRECTION WAITS FOR THE ANSWER. Putting the inputs back on the CLICK
 * also undoes the accepted click: the radio snaps back and greys out while the
 * write is in flight, which reads as a click that did not register. So the
 * clicked option stays visible until `busy` settles, and the sync then either
 * confirms it — Convex has already delivered the new `preset` by the time the
 * mutation resolves — or puts it back on the pace the server kept.
 */
watch(
	() => props.busy === true,
	(busy, wasBusy) => {
		if (wasBusy && !busy) syncFromProp();
	}
);

/**
 * A click no write ever picked up needs the same correction, so the fallback
 * runs once the parent has had its turn and `busy` never rose.
 */
function choose(preset: RampPreset | null): void {
	emit('change', preset);
	void nextTick(() => {
		if (props.busy !== true) syncFromProp();
	});
}
</script>

<template>
	<fieldset ref="group" class="space-y-2" :data-testid="`ramp-preset-${stream}`">
		<legend class="text-sm font-medium text-text-primary">
			{{
				t('components.delivery.rampPresetPicker.legend', { stream: localized(streamLabel(stream)) })
			}}
		</legend>
		<p class="text-xs text-text-secondary">
			{{ t('components.delivery.rampPresetPicker.deploymentDefault', { preset: defaultLabel }) }}
		</p>
		<div class="space-y-1">
			<label class="flex items-start gap-2 text-sm">
				<input
					type="radio"
					:name="`preset-${stream}`"
					:value="DEFAULT_VALUE"
					:checked="preset === null"
					:disabled="busy === true"
					data-testid="ramp-preset-default"
					@change="choose(null)"
				/>
				<span>
					<span class="text-text-primary">
						{{ t('components.delivery.rampPresetPicker.useDefault') }}
					</span>
					<span class="block text-xs text-text-secondary">
						{{ t('components.delivery.rampPresetPicker.useDefaultDescription') }}
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
					:value="option.value"
					:checked="preset === option.value"
					:disabled="busy === true"
					:data-testid="`ramp-preset-option-${option.value}`"
					@change="choose(option.value)"
				/>
				<span>
					<span class="text-text-primary">{{ localized(option.label) }}</span>
					<span class="block text-xs text-text-secondary">
						{{ localized(option.description) }}
					</span>
					<span
						v-if="isStandalone && option.value !== 'conservative'"
						class="block text-xs text-text-secondary"
						:data-testid="`ramp-preset-standalone-note-${option.value}`"
					>
						{{ t('components.delivery.rampPresetPicker.standaloneNote') }}
					</span>
				</span>
			</label>
		</div>
	</fieldset>
</template>
