<script setup lang="ts">
/**
 * One schema-rendered plugin settings control. Fully self-contained and
 * accessible (explicit label association, aria-describedby, aria-required, and a
 * role="switch" toggle) so the schema-driven form needs no per-field custom UI.
 *
 * A secret field is read-only: its value is supplied by a `PLUGIN_`-prefixed
 * deployment environment variable, so the control renders the variable name and
 * whether it is present, and there is no input to type a credential into.
 * SSR-safe — no window/document access, ids come from `useId()`.
 */
import { computed, useId } from 'vue';
import type { PluginSettingsField } from '@owlat/plugin-kit';
import type { PluginSettingsFormValue } from '~/utils/pluginSettings';

const props = withDefaults(
	defineProps<{
		field: PluginSettingsField;
		modelValue: PluginSettingsFormValue;
		secretSet?: boolean;
		disabled?: boolean;
	}>(),
	{ secretSet: false, disabled: false }
);

const emit = defineEmits<{ 'update:modelValue': [value: PluginSettingsFormValue] }>();

const controlId = useId();
const labelId = useId();
const descriptionId = useId();
const hintId = useId();

const describedBy = computed(() => {
	const ids: string[] = [];
	if (props.field.description) ids.push(descriptionId);
	if (props.field.kind === 'secret') ids.push(hintId);
	return ids.length > 0 ? ids.join(' ') : undefined;
});

const stringValue = computed(() => (typeof props.modelValue === 'string' ? props.modelValue : ''));
const numberValue = computed(() => (typeof props.modelValue === 'number' ? props.modelValue : ''));
const booleanValue = computed(() => props.modelValue === true);

const secretHint = computed(() =>
	props.field.kind === 'secret'
		? props.secretSet
			? `Supplied by the ${props.field.envVar} environment variable, which is set.`
			: `Set the ${props.field.envVar} environment variable in your deployment.`
		: ''
);

function onText(event: Event) {
	emit('update:modelValue', (event.target as HTMLInputElement).value);
}

function onNumber(event: Event) {
	const raw = (event.target as HTMLInputElement).value;
	// Keep an empty field as '' so required-validation can flag it, otherwise emit a number.
	emit('update:modelValue', raw === '' ? '' : Number(raw));
}

function onSelect(event: Event) {
	emit('update:modelValue', (event.target as HTMLSelectElement).value);
}

function toggle() {
	if (props.disabled) return;
	emit('update:modelValue', !booleanValue.value);
}

const inputClass =
	'w-full bg-surface-1 rounded-lg text-text-primary placeholder:text-text-tertiary px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-50 disabled:cursor-not-allowed border border-border-subtle';
</script>

<template>
	<div class="py-1">
		<!-- Boolean uses a role=switch button, named via aria-labelledby (a button
		     cannot be the target of <label for>). Secret uses the same treatment for
		     the same reason. Every remaining kind renders a real form control and is
		     named with <label for>. -->
		<div v-if="field.kind === 'boolean'" class="flex items-start justify-between gap-4">
			<div class="min-w-0">
				<span :id="labelId" class="text-sm font-medium text-text-primary">{{ field.label }}</span>
				<p v-if="field.description" :id="descriptionId" class="text-xs text-text-tertiary mt-0.5">
					{{ field.description }}
				</p>
			</div>
			<button
				type="button"
				role="switch"
				:id="controlId"
				:aria-checked="booleanValue"
				:aria-labelledby="labelId"
				:aria-describedby="describedBy"
				:disabled="disabled"
				class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 disabled:cursor-not-allowed"
				:class="booleanValue ? 'bg-brand' : 'bg-bg-surface-hover'"
				@click="toggle"
			>
				<span
					class="inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform"
					:class="booleanValue ? 'translate-x-[22px]' : 'translate-x-[2px]'"
				/>
			</button>
		</div>

		<!-- Env-supplied credential: presence only, never an editable value. The
		     presence element is a <p>, which is NOT a labelable element, so — exactly
		     like the boolean branch — it is named with aria-labelledby from a <span>
		     rather than by a <label for> pointing at a non-labelable tag, and it
		     carries aria-describedby so the "Set PLUGIN_…" hint is associated. -->
		<div v-else-if="field.kind === 'secret'">
			<span :id="labelId" class="block text-sm font-medium text-text-primary mb-1">
				{{ field.label }}
				<span v-if="field.required" class="text-error" aria-hidden="true">*</span>
			</span>
			<p v-if="field.description" :id="descriptionId" class="text-xs text-text-tertiary mb-1.5">
				{{ field.description }}
			</p>
			<p
				:id="controlId"
				role="status"
				:aria-labelledby="labelId"
				:aria-describedby="describedBy"
				class="flex items-center gap-2 text-sm rounded-lg px-3 py-2 bg-surface-1 border border-border-subtle"
				:class="secretSet ? 'text-text-primary' : 'text-text-tertiary'"
			>
				<span
					class="inline-block h-2 w-2 rounded-full"
					:class="secretSet ? 'bg-success' : 'bg-border-subtle'"
					aria-hidden="true"
				/>
				<span>{{ secretSet ? 'Set in the environment' : 'Not set' }}</span>
				<code class="ml-auto text-xs text-text-tertiary">{{ field.envVar }}</code>
			</p>
			<p :id="hintId" class="text-xs text-text-tertiary mt-1">{{ secretHint }}</p>
		</div>

		<template v-else>
			<label :for="controlId" class="block text-sm font-medium text-text-primary mb-1">
				{{ field.label }}
				<span v-if="field.required" class="text-error" aria-hidden="true">*</span>
			</label>
			<p v-if="field.description" :id="descriptionId" class="text-xs text-text-tertiary mb-1.5">
				{{ field.description }}
			</p>

			<input
				v-if="field.kind === 'string'"
				:id="controlId"
				type="text"
				:value="stringValue"
				:required="field.required || undefined"
				:aria-required="field.required || undefined"
				:aria-describedby="describedBy"
				:maxlength="field.maxLength"
				:disabled="disabled"
				:class="inputClass"
				@input="onText"
			/>

			<input
				v-else-if="field.kind === 'number'"
				:id="controlId"
				type="number"
				inputmode="decimal"
				step="any"
				:value="numberValue"
				:required="field.required || undefined"
				:aria-required="field.required || undefined"
				:aria-describedby="describedBy"
				:min="field.min"
				:max="field.max"
				:disabled="disabled"
				:class="inputClass"
				@input="onNumber"
			/>

			<select
				v-else-if="field.kind === 'select'"
				:id="controlId"
				:value="stringValue"
				:aria-required="field.required || undefined"
				:aria-describedby="describedBy"
				:disabled="disabled"
				:class="inputClass"
				@change="onSelect"
			>
				<!-- Unset select (no stored value or default): an honest, non-selectable
				     placeholder rather than the first option masquerading as configured. -->
				<option v-if="stringValue === ''" value="" disabled>Select…</option>
				<option v-for="option in field.options" :key="option.value" :value="option.value">
					{{ option.label }}
				</option>
			</select>
		</template>
	</div>
</template>
