<script setup lang="ts">
/**
 * THE CREDENTIAL FORM — one component for every send provider, present and
 * future (the seams plan's D5: "the UI renders descriptors, it doesn't know
 * providers").
 *
 * Both surfaces that collect sending credentials — the in-app transport editor
 * and step 1 of the connect-a-provider wizard — used to carry a hand-written
 * block per vendor, so a provider that needed no backend change still could not
 * ship without two `.vue` edits. This renders the selected kind's
 * `credentialFields` descriptors (`@owlat/shared/sendProviderCatalog`) instead:
 * label, control and env variable all come from the entry, and adding a provider
 * adds zero lines to this file.
 *
 * WHAT EACH FIELD KIND DRAWS, and why it is the field's business rather than the
 * provider's: `secret` is a password input (write-only, never rendered back),
 * `string` / `region-select` / `number` are text inputs, `select` is a picker
 * over its declared options, `boolean` is a checkbox, and the `host-port`
 * COMPOSITE draws the endpoint an operator actually thinks about — a preset
 * picker that prefills all three parts, the host, the port, and the implicit-TLS
 * toggle. The composite's own copy (what a preset is for, that a blank port
 * means 587) lives here because it describes the COMPOSITE, not any vendor.
 *
 * WHERE THE ERROR IS ANNOUNCED, and why it is the FORM's shape that decides.
 * `validateEmailStep` reports at most one credential error for the selected
 * kind, and it is about the credential SET ("Region, access key ID, and secret
 * access key are all required for SES"), not about one input. So:
 *
 *  - a form with ONE simple control binds it to that control, because there the
 *    set and the field are the same thing (Resend's and Mandrill's API key —
 *    exactly what those shipped blocks did);
 *  - any other form renders it as a set-level `role="alert"` paragraph after the
 *    group, which is what the shipped SES and SMTP blocks did. Binding it to one
 *    input there would put "Port must be a whole number…" under "Server host" —
 *    a control that is DISABLED on every named preset — and mark a filled-in
 *    region `aria-invalid` because the missing field was the secret below it.
 *
 * The rule is the field set's, not the provider's, so a new kind gets whichever
 * answer its own form shape earns.
 *
 * The per-field `description` a descriptor may carry is rendered under its
 * control: it is the operator guidance the ENTRY declares (Mandrill's "feedback
 * needs a second variable" note), so it travels with the provider rather than
 * with this component.
 */
import { computed } from 'vue';
import type {
	SendProviderCredentialField,
	SendProviderHostPortField,
} from '@owlat/shared/sendProviderCatalog';
import {
	credentialFieldsFor,
	readBooleanValue,
	type TransportCredentialValues,
} from '~/composables/setupWizardCredentials';
import type { SmtpPreset } from '~/composables/useSetupWizard';

const props = withDefaults(
	defineProps<{
		/** The selected transport kind; an unknown kind renders no fields at all. */
		kind: string;
		/** The live credential map, keyed by env variable (mutated in place). */
		values: TransportCredentialValues;
		/** Which preset a `host-port` field is currently prefilled from. */
		preset: SmtpPreset;
		presetOptions: { value: SmtpPreset; label: string }[];
		/** The one credential error for this kind, or undefined when there is none. */
		error?: string;
		/**
		 * Draw the endpoint composite's implicit-TLS toggle? Default true, which is
		 * the in-app transport editor's shipped form.
		 *
		 * The connect-a-provider wizard passes `false`: its step never offered the
		 * toggle, its presets all declare STARTTLS, and adding a control to a shipped
		 * screen is an additive capability — which this refactor does not get to
		 * ship. The value still travels with the patch (it is the preset's), so the
		 * env written is unchanged; only the control is withheld.
		 *
		 * `withDefaults` is load-bearing, not decoration: Vue's boolean CASTING turns
		 * an absent `boolean` prop into `false`, so without the explicit default the
		 * editor — which passes nothing — would silently lose the toggle it ships.
		 */
		endpointSecurityToggle?: boolean;
	}>(),
	{ endpointSecurityToggle: true }
);

const emit = defineEmits<{ 'update:preset': [SmtpPreset] }>();

const fields = computed(() => credentialFieldsFor(props.kind));

/**
 * The field kinds this renderer draws as ONE input that can carry a message of
 * its own. A composite draws three controls; a select and a checkbox have no
 * error slot at all — binding to either would make the message disappear.
 */
const ERROR_BEARING_KINDS: readonly string[] = ['string', 'secret', 'number', 'region-select'];

/**
 * Is this form ONE simple control? Then the credential set IS that field and its
 * error binds to it; otherwise the message belongs to the group (see the
 * docblock).
 */
const boundErrorFieldKey = computed(() => {
	const only = fields.value.length === 1 ? fields.value[0] : undefined;
	return only !== undefined && ERROR_BEARING_KINDS.includes(only.kind) ? only.key : undefined;
});

function errorFor(field: SendProviderCredentialField): string | undefined {
	return field.key === boundErrorFieldKey.value ? props.error : undefined;
}

/** The set-level message: everything the single control above does not take. */
const groupError = computed(() =>
	boundErrorFieldKey.value === undefined ? props.error : undefined
);

/**
 * The UI kit's inputs emit `string | number` and its selects `string | null`, so
 * everything is normalised to the string a form field (and an env variable)
 * actually holds. `null` is "cleared", which for a credential is the empty
 * value, not an absent key.
 */
function set(envVar: string, value: string | number | null): void {
	props.values[envVar] = value === null ? '' : String(value);
}

function textValue(envVar: string): string {
	return props.values[envVar] ?? '';
}

function checked(envVar: string, fallback: boolean): boolean {
	return readBooleanValue(props.values[envVar], fallback);
}

function onCheckbox(envVar: string, event: Event): void {
	set(envVar, String((event.target as HTMLInputElement).checked));
}

/** A composite's parts are only editable by hand on the `custom` endpoint. */
function isPresetLocked(field: SendProviderHostPortField): boolean {
	const config = field.presets?.[props.preset];
	return config !== undefined && config.host !== '';
}
</script>

<template>
	<div class="space-y-4">
		<template v-for="field in fields" :key="field.key">
			<!-- COMPOSITE: a relay endpoint — preset, host, port, implicit TLS. -->
			<div v-if="field.kind === 'host-port'" class="space-y-4">
				<UiSelect
					v-if="presetOptions.length > 0"
					:model-value="preset"
					label="Provider preset"
					:options="presetOptions"
					@update:model-value="emit('update:preset', $event as SmtpPreset)"
				/>
				<UiInput
					:model-value="textValue(field.envVar)"
					:label="field.label"
					:placeholder="field.placeholder"
					autocomplete="off"
					:disabled="isPresetLocked(field)"
					:error="errorFor(field)"
					@update:model-value="set(field.envVar, $event)"
				/>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<UiInput
						:model-value="textValue(field.portEnvVar)"
						label="Port"
						:placeholder="field.portDefault"
						autocomplete="off"
						@update:model-value="set(field.portEnvVar, $event)"
					/>
					<label
						v-if="endpointSecurityToggle"
						class="flex items-center gap-3 rounded-lg border border-border-default p-3 cursor-pointer transition-colors hover:border-border-strong"
					>
						<input
							type="checkbox"
							class="h-4 w-4 rounded border-border-default bg-bg-deep text-brand focus-visible:ring-1 focus-visible:ring-brand"
							:checked="checked(field.secureEnvVar, field.secureDefault)"
							@change="onCheckbox(field.secureEnvVar, $event)"
						/>
						<span class="text-sm text-text-secondary">
							Implicit TLS (port 465). Leave off for STARTTLS on {{ field.portDefault }}.
						</span>
					</label>
				</div>
			</div>

			<!-- A choice from a closed, declared set. -->
			<UiSelect
				v-else-if="field.kind === 'select'"
				:model-value="textValue(field.envVar) || field.default"
				:label="field.label"
				:options="[...field.options]"
				@update:model-value="set(field.envVar, $event)"
			/>

			<!-- A toggle. -->
			<label v-else-if="field.kind === 'boolean'" class="flex items-center gap-3 cursor-pointer">
				<input
					type="checkbox"
					class="h-4 w-4 rounded border-border-default bg-bg-deep text-brand focus-visible:ring-1 focus-visible:ring-brand"
					:checked="checked(field.envVar, field.default ?? false)"
					@change="onCheckbox(field.envVar, $event)"
				/>
				<span class="text-sm text-text-secondary">{{ field.label }}</span>
			</label>

			<!-- Everything else is a single-line control; only `secret` is masked. -->
			<UiInput
				v-else
				:model-value="textValue(field.envVar)"
				:label="field.label"
				:type="field.kind === 'secret' ? 'password' : 'text'"
				:placeholder="'placeholder' in field ? field.placeholder : undefined"
				autocomplete="off"
				:error="errorFor(field)"
				@update:model-value="set(field.envVar, $event)"
			/>

			<p v-if="field.description" class="text-xs text-text-tertiary">{{ field.description }}</p>

			<!-- The escape hatch a SURFACE uses to say something about one field —
			     the outbound-TLS floor's per-option guidance, for instance. Keyed by
			     the field's own key, never by a provider, so it appears only where
			     that field does and a new provider needs none of it. -->
			<slot :name="field.key" :field="field" :value="textValue(field.envVar)" />
		</template>

		<!-- The credential SET's message, for a form no single control speaks for
		     (SES's three keys, the SMTP endpoint) — the shipped placement. -->
		<p v-if="groupError" class="text-sm text-error" role="alert">{{ groupError }}</p>
	</div>
</template>
