<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isValidEmail, normalizeEmail } from '~/utils/validation';

interface ContactSuggestion {
	email: string;
	displayName?: string;
}

const props = defineProps<{
	modelValue: string[];
	mailboxId: Id<'mailboxes'>;
	label: string;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: string[]): void;
}>();

const inputValue = ref('');
const showSuggestions = ref(false);
const highlightIdx = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);

// Debounce the prefix so each keystroke doesn't re-subscribe the autocomplete
// query (and re-scan contacts on the backend).
const debouncedPrefix = ref('');
let prefixTimer: ReturnType<typeof setTimeout> | null = null;
watch(inputValue, (v) => {
	if (prefixTimer) clearTimeout(prefixTimer);
	prefixTimer = setTimeout(() => {
		debouncedPrefix.value = v.trim();
	}, 200);
});
onScopeDispose(() => {
	if (prefixTimer) clearTimeout(prefixTimer);
});

// Live autocomplete query — fires only once the debounced prefix has a value.
const { data: suggestionsData } = useConvexQuery(
	api.mail.contacts.autocomplete,
	() => {
		const v = debouncedPrefix.value;
		if (!v) return 'skip';
		return { mailboxId: props.mailboxId, prefix: v, limit: 6 };
	}
);
const suggestions = computed<ContactSuggestion[]>(() =>
	(suggestionsData.value ?? []).filter((s) => !props.modelValue.includes(s.email))
);

watch(suggestions, () => {
	highlightIdx.value = 0;
});

function addRecipient(email: string) {
	const trimmed = normalizeEmail(email);
	if (!trimmed) return;
	if (!isValidEmail(trimmed)) return;
	if (props.modelValue.includes(trimmed)) return;
	emit('update:modelValue', [...props.modelValue, trimmed]);
	inputValue.value = '';
	showSuggestions.value = false;
}

function removeRecipient(idx: number) {
	const next = [...props.modelValue];
	next.splice(idx, 1);
	emit('update:modelValue', next);
}

function onKeydown(event: KeyboardEvent) {
	if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
		event.preventDefault();
		if (showSuggestions.value && suggestions.value.length > 0) {
			const hit = suggestions.value[highlightIdx.value];
			if (hit) addRecipient(hit.email);
		} else if (inputValue.value.trim()) {
			addRecipient(inputValue.value);
		}
		return;
	}
	if (event.key === 'Backspace' && !inputValue.value && props.modelValue.length > 0) {
		event.preventDefault();
		removeRecipient(props.modelValue.length - 1);
		return;
	}
	if (event.key === 'ArrowDown' && suggestions.value.length > 0) {
		event.preventDefault();
		highlightIdx.value = (highlightIdx.value + 1) % suggestions.value.length;
		return;
	}
	if (event.key === 'ArrowUp' && suggestions.value.length > 0) {
		event.preventDefault();
		highlightIdx.value =
			(highlightIdx.value - 1 + suggestions.value.length) % suggestions.value.length;
		return;
	}
	if (event.key === 'Escape') {
		showSuggestions.value = false;
	}
}

function onInput() {
	showSuggestions.value = !!inputValue.value.trim();
}

function onBlur() {
	// Defer so click on suggestion still fires
	setTimeout(() => {
		showSuggestions.value = false;
		if (inputValue.value.trim() && isValidEmail(inputValue.value.trim())) {
			addRecipient(inputValue.value);
		}
	}, 150);
}
</script>

<template>
	<div class="flex items-baseline gap-2 relative">
		<label class="text-text-tertiary w-12 flex-shrink-0">{{ label }}</label>
		<div class="flex flex-wrap items-center gap-1 flex-1 min-h-[1.5rem]">
			<span
				v-for="(addr, idx) in modelValue"
				:key="addr"
				class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-bg-surface text-xs"
			>
				{{ addr }}
				<button
					type="button"
					class="text-text-tertiary hover:text-text-primary"
					@click="removeRecipient(idx)"
				 aria-label="Close">
					<Icon name="lucide:x" class="w-3 h-3" />
				</button>
			</span>
			<input
				ref="inputEl"
				v-model="inputValue"
				type="text"
				class="flex-1 min-w-[120px] bg-transparent outline-none text-sm"
				:placeholder="modelValue.length === 0 ? 'recipient@example.com' : ''"
				@input="onInput"
				@focus="onInput"
				@blur="onBlur"
				@keydown="onKeydown"
			/>
		</div>
		<div
			v-if="showSuggestions && suggestions.length > 0"
			data-postbox-overlay-open
			class="absolute top-full left-12 mt-1 bg-bg-elevated border border-border-subtle rounded shadow-lg w-80 max-w-[90%] z-20"
		>
			<button
				v-for="(s, idx) in suggestions"
				:key="s.email"
				type="button"
				class="w-full text-left px-3 py-1.5 text-sm hover:bg-bg-surface flex items-baseline justify-between gap-2"
				:class="idx === highlightIdx ? 'bg-bg-surface' : ''"
				@mouseenter="highlightIdx = idx"
				@mousedown.prevent
				@click="addRecipient(s.email)"
			>
				<span class="truncate">
					<span v-if="s.displayName" class="font-medium">{{ s.displayName }}</span>
					<span v-if="s.displayName" class="text-text-tertiary ml-1">&lt;{{ s.email }}&gt;</span>
					<span v-else>{{ s.email }}</span>
				</span>
			</button>
		</div>
	</div>
</template>
