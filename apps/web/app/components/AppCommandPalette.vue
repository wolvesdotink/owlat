<script setup lang="ts">
import { api } from '@owlat/api';
import {
	type PaletteArgumentSpec,
	type PaletteGroup,
	type PaletteItem,
	buildArgumentGroups,
	flattenGroups,
	groupsForMode,
	mergeGroups,
	moveSelection,
	parsePaletteQuery,
} from '~/lib/commandPalette';
import { resolvePaletteGroups, routePrefixMatcher } from '~/lib/commandPaletteRegistry';
import { PALETTE_SCOPE_LABEL_KEYS, groupsForScope } from '~/lib/commandPaletteScope';
import type { CommandPaletteOpenDetail } from '~/composables/useCommandPalette';
import {
	SEARCH_MIN_QUERY,
	type SearchResults,
	buildCorePaletteProviders,
} from '~/lib/commandPaletteCore';

/**
 * The app's ONE search overlay, mounted once in the dashboard layout so it works
 * on EVERY dashboard page. It is assembled from an ordered, deduplicated provider
 * registry (`~/lib/commandPaletteRegistry`): core providers built here are
 * consulted first, then the surface/plugin providers registered while mounted.
 *
 * It is SCOPED BY ROUTE (`~/lib/commandPaletteScope`). On Postbox it opens on
 * Mail — the full operator grammar, its autocomplete, live hits from the real
 * mail search, and Enter handing off to `/dashboard/postbox/search`. On
 * knowledge/files it opens on Ask, which answers from `quickQuery.ask` with its
 * citations right here. Everywhere else it opens on Everything, the cross-object
 * index. Tab cycles, so nothing is ever out of reach. This replaced four separate
 * boxes — this palette, the Postbox rail bar, the search page's bar and the Quick
 * Query modal — each of which had its own grammar and its own history.
 *
 * Typing is fuzzy (subsequence, with the matched characters highlighted), a
 * leading `>`/`@`/`#` narrows to commands/people/labels and `?` asks knowledge,
 * and an item may ask for an ARGUMENT — selecting it opens a second step with its
 * own option list instead of running. All of that arithmetic is pure
 * (`~/lib/commandPalette`); this component holds the state and the keyboard, and
 * `AppCommandPaletteResults` renders it.
 */

const { t } = useI18n();
const { verbItems, contextItems, navItems, settingsItems } = useCommandPaletteProviders();
const registryProviders = useCommandPaletteRegistry();
const { isEnabled: isFlagEnabled } = useFeatureFlag();
const route = useRoute();

const open = ref(false);
const activeIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
const dialogRef = ref<HTMLElement | null>(null);
/** Caret offset in the box — the Mail grammar completes a TOKEN, not the box. */
const caret = ref(0);

// Debounced so each keystroke doesn't re-run the cross-table search query.
const { searchQuery, debouncedSearch, setImmediate } = useDebouncedSearch(300);

// Tab trap + opener restore, shared with the modal dialogs. Escape/Arrow/Enter
// are handled by onInputKeydown below (single source of truth).
useModalFocus(dialogRef, () => open.value);

// ── Mode prefixes: the typed `>`/`@`/`#`/`?` never reaches a provider or the
// search index — providers see the bare term, and the mode filters the groups.
const parsedQuery = computed(() => parsePaletteQuery(searchQuery.value));
const searchTerm = computed(() => parsedQuery.value.term);
const debouncedTerm = computed(() => parsePaletteQuery(debouncedSearch.value).term);

// ── Scope: which corpus this overlay is searching right now.
const { scope, prompt, effectiveMode, isAskAvailable, resetScope, cycleScope } =
	useCommandPaletteScope(() => parsedQuery.value.mode);

// ── Recent terms, tagged with the scope they were typed in (localStorage).
// Tagged by what the box is DOING, not by the chip: a `?` question asked from
// the Everything chip is still Ask history, and belongs with the other ones.
const { recentSearches, loadRecent, saveRecent, clearRecent } = useCommandPaletteRecents(() =>
	prompt.value === 'ask' ? 'ask' : scope.value
);

// ── Object search (contacts / templates / campaigns / mail) via the shared index.
// Skipped outside the Everything-style palette: Mail and Ask have their own
// backends, and this component is mounted on every dashboard page.
const { data: searchData } = useOrganizationQuery(api.globalSearch.search, () =>
	// undefined → the wrapper skips the subscription (no empty / <2-char query).
	prompt.value === 'palette' && debouncedTerm.value.trim().length >= SEARCH_MIN_QUERY
		? { query: debouncedTerm.value, limit: 5 }
		: undefined
);
const searchResults = computed(() => searchData.value as SearchResults | undefined);

const { buildResultItems, buildMailItems, buildSearchMailItem, goToMailSearch } =
	useCommandPaletteObjectItems({
		onRemember: (term) => saveRecent(term),
		onNavigate: () => close(),
		term: () => searchTerm.value,
	});

// ── Mail scope: the operator grammar's completions and its live hits.
const mailScope = useCommandPaletteMailScope({
	query: searchTerm,
	caret,
	enabled: computed(() => prompt.value === 'mailSearch'),
	onReplace: (value, nextCaret) => {
		searchQuery.value = value;
		void nextTick(() => {
			inputEl.value?.setSelectionRange(nextCaret, nextCaret);
			inputEl.value?.focus();
			caret.value = nextCaret;
		});
	},
	onRemember: (term) => saveRecent(term),
});

// ── Ask scope: the knowledge + files question, answered inline with citations.
const askScope = useCommandPaletteAsk();

// ── Team Inbox threads: the one ROUTE-scoped corpus. The registry gates the
// provider on `/dashboard/inbox/**`; the same predicate gates the subscription
// here, so the query never runs on the other forty dashboard pages.
const isInboxRoute = computed(() => routePrefixMatcher('/dashboard/inbox')(route.path));
const inboxScope = useCommandPaletteInboxScope({
	query: searchTerm,
	enabled: computed(() => prompt.value === 'palette' && isInboxRoute.value),
	onRemember: (term) => saveRecent(term),
});

/** One spinner for whichever backend the active scope is waiting on. */
const isSearching = computed(() => {
	if (prompt.value === 'mailSearch') return mailScope.isSearching.value;
	if (prompt.value !== 'palette' || searchTerm.value.trim().length < SEARCH_MIN_QUERY) return false;
	return searchResults.value === undefined || inboxScope.isSearching.value;
});

// ── Core providers, consulted before any surface/plugin provider. Their
// composition (ids, priorities, group keys/orders/caps, gating) lives in the
// pure `buildCorePaletteProviders` factory and is pinned by its conformance
// suite; here we only inject the reactive reads and item `run` closures. Each
// getter is read inside `build`, so the assembling computed re-tracks them.
const coreProviders = buildCorePaletteProviders({
	recentSearches: () => recentSearches.value,
	verbItems: () => verbItems.value,
	contextItems: () => contextItems.value,
	navItems: () => navItems.value,
	settingsItems: () => settingsItems.value,
	searchResults: () => searchResults.value,
	// A refill keeps the typed prefix, so a recent term picked in `?`/`>` mode
	// stays in that mode instead of silently dropping back to the plain palette.
	onRecentTerm: (term) => setImmediate(`${parsedQuery.value.prefix}${term}`),
	buildResultItems,
	buildMailItems,
	buildSearchMailItem,
	isMailScope: () => prompt.value === 'mailSearch',
	mailSuggestionItems: () => mailScope.suggestionItems.value,
	mailHitItems: () => mailScope.hitItems.value,
	inboxThreadItems: () => inboxScope.threadItems.value,
});

// ── Argument step. While an item's argument is pending the palette shows only
// that item's options; the query box filters them and Escape backs out.
const pendingArgument = ref<{ item: PaletteItem; spec: PaletteArgumentSpec } | null>(null);

// ── Assemble the ordered, capped group list: gate + order + dedup providers,
// keep the groups the scope and the typed mode admit, then sort/drop-empties/cap.
// Core providers form their own trust tier and are always consulted before any
// registered surface/plugin provider, so a registered provider can add work but
// never override a core group or item.
const groups = computed<PaletteGroup[]>(() => {
	const pending = pendingArgument.value;
	if (pending) return mergeGroups(buildArgumentGroups(pending.spec, searchQuery.value));
	const resolved = resolvePaletteGroups(
		coreProviders,
		registryProviders.value,
		{ path: route.path, isFlagEnabled },
		{ query: searchTerm.value, mode: effectiveMode.value }
	);
	// Ask replaces the object list with one answer; only the history survives it,
	// and it survives the `?` prefix too (no provider declares the `ask` mode, so
	// the usual mode filter would blank it).
	if (prompt.value === 'ask') {
		return mergeGroups(resolved.filter((group) => group.key === 'recent'));
	}
	const scoped = groupsForScope(resolved, scope.value, effectiveMode.value);
	return mergeGroups(groupsForMode(scoped, effectiveMode.value));
});

// What the rows highlight against: the argument step filters on the raw box,
// everything else on the prefix-stripped term.
const matchTerm = computed(() => (pendingArgument.value ? searchQuery.value : searchTerm.value));

const flatItems = computed(() => flattenGroups(groups.value));
const flatIndexById = computed(() => {
	const map = new Map<string, number>();
	flatItems.value.forEach((item, index) => map.set(item.id, index));
	return map;
});
const hasAnyResults = computed(() => flatItems.value.length > 0);

/**
 * Where the highlight sits when the rows change.
 *
 * Mail scope opens with NOTHING selected, the way the search bar it replaced
 * did: a search box's primary action is that Enter runs what you typed, and
 * pre-selecting a row would make Enter open somebody's message instead of the
 * results page. An arrow key hands the keyboard over to the list.
 */
const restingIndex = computed(() => (prompt.value === 'mailSearch' ? -1 : 0));
watch(flatItems, () => {
	activeIndex.value = restingIndex.value;
});

const scopeLabel = computed(() => t(PALETTE_SCOPE_LABEL_KEYS[scope.value]));
const placeholder = computed(() => {
	if (prompt.value === 'ask') return t('components.query.quickQueryPanel.placeholder');
	if (scope.value === 'mail') return t('components.postbox.postboxSearchBar.placeholder');
	return t('components.appCommandPalette.searchPlaceholder');
});

function syncCaret() {
	caret.value = inputEl.value?.selectionStart ?? searchQuery.value.length;
}

async function openPalette(detail?: CommandPaletteOpenDetail) {
	open.value = true;
	searchQuery.value = '';
	activeIndex.value = 0;
	caret.value = 0;
	pendingArgument.value = null;
	resetScope(detail?.scope);
	mailScope.resetQuery();
	inboxScope.resetQuery();
	askScope.reset();
	loadRecent();
	await nextTick();
	inputEl.value?.focus();
}

function close() {
	open.value = false;
	searchQuery.value = '';
	activeIndex.value = 0;
	pendingArgument.value = null;
	mailScope.resetQuery();
	inboxScope.resetQuery();
	askScope.reset();
}

/** Leave the argument step, back to the palette that opened it. */
function cancelArgument() {
	pendingArgument.value = null;
	searchQuery.value = '';
	activeIndex.value = 0;
	void nextTick(() => inputEl.value?.focus());
}

function runItem(item: PaletteItem | undefined) {
	if (!item) return;
	if (item.argument) {
		// Two-step: ask for the argument instead of running. `run` never fires for
		// an item that has one, so a provider can leave it as a no-op.
		pendingArgument.value = { item, spec: item.argument };
		searchQuery.value = '';
		activeIndex.value = 0;
		void nextTick(() => inputEl.value?.focus());
		return;
	}
	if (item.keepOpen) {
		item.run();
		void nextTick(() => inputEl.value?.focus());
		return;
	}
	close();
	item.run();
}

/** Enter: run the highlighted row, or — with none — do what the scope means. */
function onEnter() {
	if (prompt.value === 'ask') {
		saveRecent(searchTerm.value);
		void askScope.ask(searchTerm.value);
		return;
	}
	const item = flatItems.value[activeIndex.value];
	if (item) {
		runItem(item);
		return;
	}
	if (prompt.value === 'mailSearch' && searchTerm.value.trim()) goToMailSearch(searchTerm.value);
}

function onInputKeydown(event: KeyboardEvent) {
	if (event.key === 'Escape') {
		event.preventDefault();
		// Escape unwinds one level at a time: out of the argument step first.
		if (pendingArgument.value) cancelArgument();
		else close();
		return;
	}
	// Backspacing past the start of an empty argument query also backs out, the
	// way a deleted chip behaves everywhere else in the app.
	if (event.key === 'Backspace' && pendingArgument.value && searchQuery.value === '') {
		event.preventDefault();
		cancelArgument();
		return;
	}
	// Tab cycles the SCOPE rather than moving focus: the overlay is one input, and
	// the argument step is a sub-list of one scope, so it opts out.
	if (event.key === 'Tab' && !pendingArgument.value) {
		event.preventDefault();
		cycleScope();
		activeIndex.value = restingIndex.value;
		return;
	}
	if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
		event.preventDefault();
		activeIndex.value = moveSelection(activeIndex.value, event.key, flatItems.value.length);
	} else if (event.key === 'Enter') {
		event.preventDefault();
		onEnter();
	}
}

// ── Global open triggers. This palette owns plain Cmd/Ctrl+K everywhere, and
// Cmd/Ctrl+Shift+K is now an ALIAS that opens it pre-switched to Ask — the
// knowledge Quick Query's own shortcut, unchanged, gated on the same
// `ai.knowledge` flag the panel it replaced was gated on.
function onGlobalKey(event: KeyboardEvent) {
	if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
	if (event.shiftKey) {
		if (!isAskAvailable.value) return;
		event.preventDefault();
		void openPalette({ scope: 'ask' });
		return;
	}
	event.preventDefault();
	if (open.value) close();
	else void openPalette();
}

// Header/mobile search buttons, the desktop titlebar pill and the Postbox `/`
// shortcut all open us; the detail names a scope when the caller has one.
function onExternalOpen(event: Event) {
	if (open.value) return;
	void openPalette((event as CustomEvent<CommandPaletteOpenDetail>).detail ?? undefined);
}

// The palette's own "Ask knowledge…" verb keeps its event seam; it now switches
// this overlay instead of opening a second modal.
function onOpenAsk() {
	if (isAskAvailable.value) void openPalette({ scope: 'ask' });
}

onMounted(() => {
	loadRecent();
	window.addEventListener('keydown', onGlobalKey);
	window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onExternalOpen);
	window.addEventListener('owlat:open-knowledge-query', onOpenAsk);
});
onBeforeUnmount(() => {
	window.removeEventListener('keydown', onGlobalKey);
	window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onExternalOpen);
	window.removeEventListener('owlat:open-knowledge-query', onOpenAsk);
});
</script>

<template>
	<Teleport to="body">
		<Transition
			enter-active-class="transition-opacity duration-(--motion-fast)"
			enter-from-class="opacity-0"
			enter-to-class="opacity-100"
			leave-active-class="transition-opacity duration-(--motion-fast-exit)"
			leave-from-class="opacity-100"
			leave-to-class="opacity-0"
		>
			<div v-if="open" class="fixed inset-0 bg-bg-deep/80 backdrop-blur-sm z-50" @click="close" />
		</Transition>

		<Transition
			enter-active-class="transition-all duration-(--motion-moderate)"
			enter-from-class="opacity-0 scale-95"
			enter-to-class="opacity-100 scale-100"
			leave-active-class="transition-all duration-(--motion-moderate-exit)"
			leave-from-class="opacity-100 scale-100"
			leave-to-class="opacity-0 scale-95"
		>
			<div
				v-if="open"
				ref="dialogRef"
				role="dialog"
				aria-modal="true"
				:aria-label="t('components.appCommandPalette.dialogLabel')"
				class="fixed inset-x-4 top-[12%] mx-auto max-w-xl bg-bg-elevated rounded-xl shadow-surface-6 z-50 overflow-hidden"
			>
				<!-- Search input -->
				<div class="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
					<!-- The scope chip. `tabindex="-1"` on purpose: Tab inside the overlay
					     is bound to cycling the scope, so the chip could never be reached
					     by it anyway, and leaving it out of the tab ring keeps the focus
					     trap's "first focusable" on the input, where typing belongs. -->
					<button
						v-if="!pendingArgument"
						type="button"
						tabindex="-1"
						class="flex-shrink-0 text-xs font-medium px-2 py-1 rounded-full bg-brand/10 text-brand hover:bg-brand/20 transition-colors duration-(--motion-fast)"
						:aria-label="t('components.appCommandPalette.scopeLabel')"
						:title="t('components.appCommandPalette.scopeLabel')"
						@click="cycleScope"
					>
						{{ scopeLabel }}
					</button>
					<span
						v-else
						class="flex-shrink-0 text-xs px-2 py-1 rounded bg-bg-surface text-text-secondary"
					>
						{{ t(pendingArgument.spec.promptKey) }}
					</span>
					<input
						ref="inputEl"
						v-model="searchQuery"
						type="text"
						:placeholder="placeholder"
						class="flex-1 bg-transparent text-text-primary placeholder-text-tertiary outline-none text-base"
						role="combobox"
						aria-expanded="true"
						aria-controls="app-cmdk-list"
						:aria-label="t('components.appCommandPalette.dialogLabel')"
						:aria-activedescendant="
							flatItems[activeIndex] ? `app-cmdk-opt-${activeIndex}` : undefined
						"
						@keydown="onInputKeydown"
						@keyup="syncCaret"
						@click="syncCaret"
						@input="syncCaret"
					/>
					<button
						v-if="searchQuery"
						class="p-1 text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast)"
						:aria-label="t('components.appCommandPalette.clearQuery')"
						@click="searchQuery = ''"
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
					<kbd
						class="hidden sm:inline-flex items-center px-2 py-1 text-xs text-text-tertiary bg-bg-surface border border-border-subtle rounded"
					>
						esc
					</kbd>
				</div>

				<AppCommandPaletteResults
					:groups="groups"
					:active-index="activeIndex"
					:index-by-id="flatIndexById"
					:match-term="matchTerm"
					:prompt="prompt"
					:is-searching="isSearching"
					:has-rows="hasAnyResults"
					:ask-answer="askScope.answer.value"
					:ask-loading="askScope.isLoading.value"
					@run="runItem"
					@hover="activeIndex = $event"
					@clear-recent="clearRecent"
				/>

				<AppCommandPaletteFooter :pending-argument="!!pendingArgument" />
			</div>
		</Transition>
	</Teleport>
</template>
