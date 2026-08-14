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
 * `string` / `number` are text inputs, `select` is a picker over its declared
 * options, `boolean` is a checkbox, and the `host-port` COMPOSITE draws the
 * endpoint an operator actually thinks about — a preset picker that prefills all
 * three parts, the host, the port, and the implicit-TLS toggle. The composite's
 * own copy (what a preset is for, that a blank port means 587) lives here
 * because it describes the COMPOSITE, not any vendor.
 *
 * `region-select` IS TWO DRAWINGS, because the descriptor says so: its `options`
 * are "present only when the provider's region set is closed and known to us".
 * Declared, it is a picker like any other closed set; absent — which is every
 * shipped entry, since SES's region list changes when AWS adds a region — it is
 * the free-text input the shipped SES form has always been. A renderer that only
 * ever drew the text box would silently drop a provider N+1's declared region
 * set on the floor, with a green build and a green suite: exactly the "adding a
 * provider adds zero lines to a .vue file" claim failing quietly.
 *
 * WHERE THE ERROR IS ANNOUNCED, and why it is the FORM's shape that decides.
 * `validateEmailStep` reports at most one credential error for the selected
 * kind, and it is about the credential SET ("Region, access key ID, and secret
 * access key are all required for SES"), not about one input. So:
 *
 *  - a form with ONE control that can speak for itself binds it to that control,
 *    because there the set and the field are the same thing (Resend's and
 *    Mandrill's API key — exactly what those shipped blocks did). "Can speak for
 *    itself" is every kind drawn as a `UiInput` or a `UiSelect`, both of which
 *    render an `error` of their own; see {@link ERROR_BEARING_KINDS} for the two
 *    that cannot;
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
 * with this component. ENV VARIABLE NAMES INSIDE IT RENDER AS CODE, because both
 * hand-written blocks this replaced wrapped that name in a `<code>` and a
 * variable an operator has to go and set is the one token in the sentence they
 * have to copy exactly. Recognised by SHAPE (`WORD_WORD`), never by a list, so a
 * new provider's note is typeset the same way with nothing added here.
 */
import { computed } from 'vue';
import type {
	SendProviderCredentialField,
	SendProviderFieldOption,
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

const { t } = useI18n();

const fields = computed(() => credentialFieldsFor(props.kind));

/**
 * The field kinds this renderer draws as ONE control that can carry a message of
 * its own — every kind that ends up as a `UiInput` or a `UiSelect`, both of
 * which render an `error` beneath themselves.
 *
 * `host-port` is out because the composite draws THREE controls, and `boolean`
 * because the checkbox this file hand-rolls has no error slot at all: binding to
 * either would make the message disappear. `region-select` is in whichever of
 * its two drawings it takes, which is why the select branch is passed the error
 * too — a provider N+1 whose whole form is one region-select with a declared
 * option set would otherwise submit empty, be refused, and be told nothing.
 */
const ERROR_BEARING_KINDS: readonly string[] = [
	'string',
	'secret',
	'number',
	'select',
	'region-select',
];

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

/**
 * The CLOSED option set a field declares, or none — the one question that
 * decides whether a field is drawn as a picker.
 *
 * Written as a function rather than as a condition in the template so both
 * option-bearing kinds answer it the same way, and so a `region-select` that
 * declares its provider's region set cannot fall through to the text input with
 * its options quietly discarded.
 */
function declaredOptions(field: SendProviderCredentialField): readonly SendProviderFieldOption[] {
	if (field.kind === 'select') return field.options;
	if (field.kind === 'region-select') return field.options ?? [];
	return [];
}

/** The descriptor's declared default, for the kinds whose default is text. */
function defaultValue(field: SendProviderCredentialField): string {
	return 'default' in field && typeof field.default === 'string' ? field.default : '';
}

/** An env-variable NAME as it appears inside prose: `MANDRILL_WEBHOOK_KEY`. */
const ENV_VAR_IN_PROSE = /[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/g;

/**
 * A descriptor's guidance sentence, split into plain runs and env-variable
 * names, so the latter can be typeset as code (see the docblock). Shape-matched
 * rather than matched against the entry's own variable lists: the note may name
 * a variable the entry declares nowhere near this field, and an acronym like
 * DMARC or SPF has no underscore, so it stays prose.
 */
function descriptionParts(text: string): { text: string; code: boolean }[] {
	const parts: { text: string; code: boolean }[] = [];
	let cursor = 0;
	for (const match of text.matchAll(ENV_VAR_IN_PROSE)) {
		if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index), code: false });
		parts.push({ text: match[0], code: true });
		cursor = match.index + match[0].length;
	}
	if (cursor < text.length) parts.push({ text: text.slice(cursor), code: false });
	return parts;
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
					:label="t('components.delivery.transportCredentialFields.providerPreset')"
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
				<!-- Port and the implicit-TLS toggle share a row — but only while there
				     ARE two cells. A surface that withholds the toggle (the wizard's
				     step) would otherwise leave the port at half width on any viewport
				     ≥ sm, where the shipped step drew it full width. -->
				<div
					data-testid="endpoint-secondary-row"
					:class="endpointSecurityToggle ? 'grid grid-cols-1 gap-4 sm:grid-cols-2' : ''"
				>
					<UiInput
						:model-value="textValue(field.portEnvVar)"
						:label="t('components.delivery.transportCredentialFields.port')"
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
							{{
								t('components.delivery.transportCredentialFields.implicitTls', {
									port: field.portDefault,
								})
							}}
						</span>
					</label>
				</div>
			</div>

			<!-- A choice from a closed, declared set — a `select`, or a
			     `region-select` whose provider's region set is closed and declared. -->
			<UiSelect
				v-else-if="field.kind === 'select' || declaredOptions(field).length > 0"
				:model-value="textValue(field.envVar) || defaultValue(field)"
				:label="field.label"
				:options="[...declaredOptions(field)]"
				:error="errorFor(field)"
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

			<!-- The entry's own guidance, with the variable names in it typeset as
			     code (both hand-written blocks this replaced did). The runs are
			     concatenated with no separator: Vue's `condense` whitespace mode drops
			     the newline-bearing text nodes between these elements, so the sentence
			     reads exactly as declared. -->
			<p v-if="field.description" class="text-xs text-text-tertiary">
				<template v-for="(part, index) in descriptionParts(field.description)" :key="index">
					<code v-if="part.code" class="text-text-primary">{{ part.text }}</code>
					<template v-else>{{ part.text }}</template>
				</template>
			</p>

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
