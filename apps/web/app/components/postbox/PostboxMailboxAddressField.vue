<script setup lang="ts">
/*
 * A hosted mailbox address as one field: the local part, a fixed "@" and the
 * domain picker share a single `.input` wrapper. The domain <select> must not
 * carry `.input` itself: that recipe is `w-full`, so in a flex row it takes the
 * whole width and squeezes the local part down to nothing. Here the select is
 * as wide as its longest domain (capped) and the local part takes the rest.
 */
export interface MailboxDomainOption {
	value: string;
	label: string;
}

const props = defineProps<{
	id?: string;
	domains: readonly MailboxDomainOption[];
	placeholder?: string;
	/** Text of the empty option, also the select's accessible name. */
	selectDomainLabel: string;
	disabled?: boolean;
	invalid?: boolean;
}>();

const emit = defineEmits<{
	/** The person typed in the local part (not a programmatic update). */
	'localpart-input': [];
}>();

const localpart = defineModel<string>('localpart', { required: true });
const domain = defineModel<string>('domain', { required: true });

const generatedId = useId();
const inputId = computed(() => props.id || generatedId);
</script>

<template>
	<div class="input flex items-center gap-1" :class="{ 'input-error': invalid }">
		<input
			:id="inputId"
			v-model="localpart"
			type="text"
			:placeholder="placeholder"
			class="input-bare min-w-0 flex-1"
			:disabled="disabled"
			:aria-invalid="invalid || undefined"
			pattern="[a-zA-Z0-9.\-_]+"
			autocapitalize="off"
			autocomplete="off"
			spellcheck="false"
			@input="emit('localpart-input')"
		/>
		<span class="shrink-0 text-text-tertiary" aria-hidden="true">@</span>
		<select
			v-model="domain"
			class="input-bare max-w-[60%] shrink-0 cursor-pointer truncate disabled:cursor-not-allowed"
			:class="domain ? 'text-text-primary' : 'text-text-tertiary'"
			:disabled="disabled"
			:aria-label="selectDomainLabel"
		>
			<option value="">{{ selectDomainLabel }}</option>
			<option v-for="d in domains" :key="d.value" :value="d.value" class="text-text-primary">
				{{ d.label }}
			</option>
		</select>
	</div>
</template>
