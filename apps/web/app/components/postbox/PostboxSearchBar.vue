<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	NO_SUGGESTION,
	type SearchSuggestion,
	activeSearchToken,
	applySearchSuggestion,
	buildSearchSuggestions,
	loadRecentSearches,
	moveSuggestionIndex,
	pushRecentSearch,
	saveRecentSearches,
	selectedSuggestion,
} from '~/utils/postboxSearchSuggest';

/**
 * The Postbox search box, with an autocomplete dropdown over the operator
 * grammar.
 *
 * The bar used to be a plain input: nothing hinted that `is:unread` or
 * `has:attachment` existed, so the grammar was only usable by people who had
 * read about it. Typing now offers the operators, the address book and the
 * mailbox's labels for the token under the caret, plus the queries you ran
 * before — the same localStorage history pattern the command palette uses,
 * under its own key so Postbox history and object-search history stay apart.
 *
 * The ranking itself is pure (`~/utils/postboxSearchSuggest`); this component
 * owns the caret, the two data subscriptions, and the keyboard.
 */

const { t } = useI18n();

const props = defineProps<{
	modelValue: string;
	/**
	 * Enables the data-backed completions (`from:` addresses, `label:` names).
	 * Without it the bar still completes the grammar and the history, which is
	 * what the collapsed rail and any mailbox-less mount can offer.
	 */
	mailboxId?: Id<'mailboxes'> | null;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: string): void;
	(e: 'submit', value: string): void;
}>();

const local = ref(props.modelValue);
watch(
	() => props.modelValue,
	(v) => {
		if (v !== local.value) local.value = v;
	}
);
watch(local, (v) => emit('update:modelValue', v));
const inputEl = ref<HTMLInputElement | null>(null);

// ── The token under the caret ──────────────────────────────────────────────
const caret = ref(0);
const isOpen = ref(false);
/**
 * The highlighted row, or `NO_SUGGESTION` for "none". The list deliberately
 * opens with nothing selected so Enter keeps running the typed query; an arrow
 * key is what hands the keyboard over to the dropdown.
 */
const activeIndex = ref(NO_SUGGESTION);
const listId = useId();

function syncCaret() {
	caret.value = inputEl.value?.selectionStart ?? local.value.length;
}

const token = computed(() => activeSearchToken(local.value, caret.value));

/** The operand being typed, when the active token opens one. */
const operand = computed(() => {
	const body = token.value.text.replace(/^-/, '');
	const colon = body.indexOf(':');
	if (colon <= 0) return null;
	return {
		op: body.slice(0, colon).toLowerCase(),
		value: body.slice(colon + 1).replace(/^"|"$/g, ''),
	};
});

// ── Data-backed operands ───────────────────────────────────────────────────
// Debounced so holding a key down doesn't re-open the contacts subscription on
// every character; the labels list is one small per-mailbox read and needs no
// debounce of its own.
const { query: contactPrefix, debouncedQuery: debouncedContactPrefix } = useDebouncedSearch(200);
watch(operand, (current) => {
	contactPrefix.value =
		current && ['from', 'to', 'cc', 'bcc'].includes(current.op) ? current.value : '';
});

const { data: contactData } = useConvexQuery(api.mail.contacts.autocomplete, () =>
	props.mailboxId && debouncedContactPrefix.value
		? { mailboxId: props.mailboxId, prefix: debouncedContactPrefix.value, limit: 6 }
		: 'skip'
);
const contacts = computed(() =>
	(contactData.value ?? []).map((contact) => ({
		email: contact.email,
		displayName: contact.displayName ?? undefined,
	}))
);

const mailboxIdRef = computed(() => props.mailboxId ?? null);
const { labels } = usePostboxLabels(mailboxIdRef);

// ── History ────────────────────────────────────────────────────────────────
const recents = ref<string[]>([]);
onMounted(() => {
	recents.value = loadRecentSearches();
});

function rememberQuery(value: string) {
	recents.value = pushRecentSearch(recents.value, value);
	saveRecentSearches(recents.value);
}

// ── Rows ───────────────────────────────────────────────────────────────────
const suggestions = computed<SearchSuggestion[]>(() =>
	buildSearchSuggestions({
		token: token.value.text,
		boxEmpty: local.value.trim().length === 0,
		contacts: contacts.value,
		labels: labels.value,
		recents: recents.value,
	})
);

// Typing another character re-ranks the rows, so any highlight the user set is
// stale — drop back to "no selection" rather than silently pointing Enter at
// whatever now sits in that slot.
watch(suggestions, () => {
	activeIndex.value = NO_SUGGESTION;
});

const isListVisible = computed(() => isOpen.value && suggestions.value.length > 0);
const activeOptionId = computed(() =>
	isListVisible.value && activeIndex.value >= 0 ? `${listId}-${activeIndex.value}` : undefined
);

function accept(suggestion: SearchSuggestion) {
	if (suggestion.kind === 'recent') {
		// A history entry is a whole query, so it replaces the box rather than
		// the token — accepting "is:unread from:ines" mid-word must not splice it
		// into the middle of what is already typed.
		local.value = suggestion.insert;
		isOpen.value = false;
		void nextTick(() => {
			syncCaret();
			submit();
		});
		return;
	}
	const next = applySearchSuggestion(local.value, token.value, suggestion.insert);
	// An operator that opens an operand (`from:`) keeps the box open on its
	// value list; a complete term (`is:unread`) gets a trailing space so the
	// next term starts clean.
	local.value = suggestion.isTerminal ? `${next.value} ` : next.value;
	const nextCaret = suggestion.isTerminal ? next.caret + 1 : next.caret;
	void nextTick(() => {
		inputEl.value?.setSelectionRange(nextCaret, nextCaret);
		inputEl.value?.focus();
		syncCaret();
	});
}

function submit() {
	rememberQuery(local.value);
	isOpen.value = false;
	emit('submit', local.value);
}

function focus() {
	inputEl.value?.focus();
	inputEl.value?.select();
	syncCaret();
	activeIndex.value = NO_SUGGESTION;
	isOpen.value = true;
}

function onKeydown(event: KeyboardEvent) {
	if (event.key === 'ArrowDown' && isListVisible.value) {
		event.preventDefault();
		activeIndex.value = moveSuggestionIndex(activeIndex.value, suggestions.value.length, 1);
		return;
	}
	if (event.key === 'ArrowUp' && isListVisible.value) {
		event.preventDefault();
		activeIndex.value = moveSuggestionIndex(activeIndex.value, suggestions.value.length, -1);
		return;
	}
	if (event.key === 'Escape' && isListVisible.value) {
		// Swallowed only while the list is up, so Escape keeps its usual meaning
		// (close the drawer / clear focus) the rest of the time.
		event.preventDefault();
		event.stopPropagation();
		isOpen.value = false;
		return;
	}
	// Both completion keys accept only a row the user selected with the arrows.
	// Unselected, Tab keeps moving focus and Enter runs the typed query.
	if (event.key === 'Tab' && isListVisible.value) {
		const picked = selectedSuggestion(suggestions.value, activeIndex.value);
		if (picked) {
			event.preventDefault();
			accept(picked);
		}
		return;
	}
	if (event.key === 'Enter') {
		event.preventDefault();
		const picked = isListVisible.value
			? selectedSuggestion(suggestions.value, activeIndex.value)
			: undefined;
		if (picked) accept(picked);
		else submit();
	}
}

defineExpose({ focus });
</script>

<template>
	<div class="relative w-full">
		<Icon
			name="lucide:search"
			class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
		/>
		<input
			ref="inputEl"
			v-model="local"
			type="text"
			class="input w-full pl-9 pr-3"
			role="combobox"
			aria-autocomplete="list"
			:aria-expanded="isListVisible"
			:aria-controls="listId"
			:aria-activedescendant="activeOptionId"
			:placeholder="t('components.postbox.postboxSearchBar.placeholder')"
			@keydown="onKeydown"
			@input="
				syncCaret();
				isOpen = true;
			"
			@click="syncCaret"
			@keyup="syncCaret"
			@focus="
				syncCaret();
				isOpen = true;
			"
			@blur="isOpen = false"
		/>
		<!-- `mousedown.prevent` on the rows: a plain click would blur the input
		     first, close the list, and drop the click on the way down. -->
		<ul
			v-if="isListVisible"
			:id="listId"
			role="listbox"
			:aria-label="t('components.postbox.postboxSearchBar.suggestionsLabel')"
			class="absolute left-0 right-0 top-full mt-1 z-30 max-h-72 overflow-auto rounded-md border border-border-default bg-bg-surface shadow-lg py-1"
		>
			<li
				v-for="(suggestion, index) in suggestions"
				:id="`${listId}-${index}`"
				:key="suggestion.id"
				role="option"
				:aria-selected="index === activeIndex"
				class="px-2"
			>
				<button
					type="button"
					class="w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
					:class="
						index === activeIndex ? 'bg-bg-elevated text-text-primary' : 'text-text-secondary'
					"
					@mousedown.prevent="accept(suggestion)"
					@mouseenter="activeIndex = index"
				>
					<Icon :name="suggestion.icon" class="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
					<span class="truncate font-mono text-xs">{{ suggestion.label }}</span>
					<span v-if="suggestion.hint" class="ml-auto truncate text-xs text-text-tertiary">{{
						t(suggestion.hint.key, suggestion.hint.params ?? {})
					}}</span>
					<span v-else-if="suggestion.detail" class="ml-auto truncate text-xs text-text-tertiary">{{
						suggestion.detail
					}}</span>
					<span
						v-else-if="suggestion.kind === 'recent'"
						class="ml-auto flex-shrink-0 text-xs text-text-tertiary"
						>{{ t('components.postbox.postboxSearchBar.suggestions.recent') }}</span
					>
				</button>
			</li>
		</ul>
	</div>
</template>
