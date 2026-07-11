<script setup lang="ts">
/**
 * A password input for a provider API key, plus the masked "saved key" hint,
 * for the AI-provider settings page. The plaintext is `defineModel`'d back to
 * the parent; leaving it blank keeps the stored key (secrets never round-trip —
 * only a `keyPreview` comes back from the backend). Used for both the language
 * key and the hosted-embedder key.
 */
defineProps<{
	label: string;
	/** True when a key is already encrypted on the row (blank = keep it). */
	storedKeySet: boolean;
	/** Masked preview of the stored key (e.g. `sk-…a1b2`), if any. */
	keyPreview?: string;
	error?: string | null;
	helpText?: string;
	disabled?: boolean;
}>();

const model = defineModel<string>({ required: true });
</script>

<template>
	<div>
		<UiInput
			v-model="model"
			type="password"
			:label="label"
			autocomplete="off"
			:placeholder="storedKeySet ? 'Leave blank to keep the saved key' : 'Paste your API key'"
			:error="error ?? undefined"
			:disabled="disabled"
			:help-text="helpText"
		/>
		<p
			v-if="storedKeySet && keyPreview"
			class="mt-1.5 text-xs text-text-tertiary flex items-center gap-1.5"
		>
			<Icon name="lucide:key-round" class="w-3.5 h-3.5" />
			Saved key: <span class="font-mono">{{ keyPreview }}</span>
		</p>
	</div>
</template>
