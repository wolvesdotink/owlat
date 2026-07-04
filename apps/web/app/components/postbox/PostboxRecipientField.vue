<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isValidEmail, normalizeEmail } from '~/utils/validation';
import { isExternalRecipient } from '~/utils/recipientHints';

interface ContactSuggestion {
	email: string;
	displayName?: string;
}

type RecipientField = 'to' | 'cc' | 'bcc';

const props = withDefaults(
	defineProps<{
		modelValue: string[];
		mailboxId: Id<'mailboxes'>;
		label: string;
		/** Which envelope field this is — carried in drag payloads. */
		field?: RecipientField;
		/** The user's own domains; a chip outside them is flagged as external. */
		ownDomains?: string[];
	}>(),
	{ field: 'to', ownDomains: () => [] }
);

const emit = defineEmits<{
	(e: 'update:modelValue', value: string[]): void;
	(e: 'move', payload: { email: string; from: RecipientField }): void;
}>();

const ownDomainLabel = computed(() => props.ownDomains[0] ?? '');
function isExternal(addr: string): boolean {
	return isExternalRecipient(addr, props.ownDomains);
}

// ─── Drag a chip out of this field (dropped onto another) ────────────────────
function onChipDragStart(event: DragEvent, addr: string) {
	if (!event.dataTransfer) return;
	event.dataTransfer.effectAllowed = 'move';
	event.dataTransfer.setData(
		'application/x-postbox-recipient',
		JSON.stringify({ email: addr, from: props.field })
	);
}
function onFieldDrop(event: DragEvent) {
	const raw = event.dataTransfer?.getData('application/x-postbox-recipient');
	if (!raw) return;
	event.preventDefault();
	try {
		const payload = JSON.parse(raw) as { email: string; from: RecipientField };
		if (payload.email && payload.from && payload.from !== props.field) {
			emit('move', payload);
		}
	} catch {
		// Ignore a malformed / foreign drag payload.
	}
}

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
const { data: suggestionsData } = useConvexQuery(api.mail.contacts.autocomplete, () => {
	const v = debouncedPrefix.value;
	if (!v) return 'skip';
	return { mailboxId: props.mailboxId, prefix: v, limit: 6 };
});
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

/** Pop the last chip off and load it into the input for editing. */
function editLastChip() {
	const last = props.modelValue[props.modelValue.length - 1];
	if (last === undefined) return;
	emit('update:modelValue', props.modelValue.slice(0, -1));
	inputValue.value = last;
	showSuggestions.value = false;
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
		// Gmail behavior: pop the last chip back into the input as editable text
		// rather than deleting it outright, so a mistyped recipient is fixable.
		event.preventDefault();
		editLastChip();
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
		<div
			class="flex flex-wrap items-center gap-1 flex-1 min-h-[1.5rem]"
			@dragover.prevent
			@drop="onFieldDrop"
		>
			<span
				v-for="(addr, idx) in modelValue"
				:key="addr"
				draggable="true"
				class="inline-flex items-center gap-1 pl-0.5 pr-2 py-0.5 rounded-full bg-bg-surface text-xs cursor-grab active:cursor-grabbing"
				:class="isExternal(addr) ? 'ring-1 ring-amber-400/70 dark:ring-amber-500/60' : ''"
				:title="isExternal(addr) && ownDomainLabel ? `outside ${ownDomainLabel}` : undefined"
				@dragstart="onChipDragStart($event, addr)"
			>
				<UiAvatar
					:email="addr"
					deterministic-color
					size="xs"
					class="flex-shrink-0"
					aria-hidden="true"
				/>
				{{ addr }}
				<button
					type="button"
					class="text-text-tertiary hover:text-text-primary"
					@click="removeRecipient(idx)"
					:aria-label="`Remove ${addr}`"
				>
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
				class="w-full text-left px-3 py-1.5 text-sm hover:bg-bg-surface flex items-center gap-2"
				:class="idx === highlightIdx ? 'bg-bg-surface-hover' : ''"
				@mouseenter="highlightIdx = idx"
				@mousedown.prevent
				@click="addRecipient(s.email)"
			>
				<UiAvatar
					:name="s.displayName"
					:email="s.email"
					deterministic-color
					size="sm"
					class="flex-shrink-0"
					aria-hidden="true"
				/>
				<span class="truncate">
					<span v-if="s.displayName" class="font-medium">{{ s.displayName }}</span>
					<span v-if="s.displayName" class="text-text-tertiary ml-1">&lt;{{ s.email }}&gt;</span>
					<span v-else>{{ s.email }}</span>
				</span>
			</button>
		</div>
	</div>
</template>
