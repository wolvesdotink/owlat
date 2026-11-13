<script setup lang="ts">
import { api } from '@owlat/api';
import {
	type PaletteGroup,
	type PaletteItem,
	applyRecencyTieBreak,
	buildArgumentGroups,
	flattenGroups,
	groupsForMode,
	indexById,
	mergeGroups,
	moveSelection,
	parsePaletteQuery,
} from '~/lib/commandPalette';
import { resolvePaletteGroups, routePrefixMatcher } from '~/lib/commandPaletteRegistry';
import { PALETTE_SCOPE_LABEL_KEYS, groupsForScope } from '~/lib/commandPaletteScope';
import {
	type CommandPaletteOpenDetail,
	listenForCommandPaletteTriggers,
} from '~/composables/useCommandPalette';
import {
	SEARCH_MIN_QUERY,
	type SearchResults,
	buildCorePaletteProviders,
} from '~/lib/commandPaletteCore';
import { isImeComposing } from '~/utils/imeComposition';
import { useAnnounce } from '~/composables/useAnnounce';

/**
 * The app's ONE search overlay, mounted by the dashboard layout the first time
 * it is asked for (`useCommandPaletteHost` listens until then) and kept for the
 * rest of the session, so it works on EVERY dashboard page. It is assembled from an ordered, deduplicated provider
 * registry (`~/lib/commandPaletteRegistry`): core providers built here are
 * consulted first, then the surface/plugin providers registered while mounted.
 *
 * It is SCOPED BY ROUTE (`~/lib/commandPaletteScope`). On Postbox it opens on Mail — the full
 * operator grammar, its autocomplete, live hits from the real mail search, and Enter handing off
 * to `/dashboard/postbox/search`. On knowledge/files it opens on Ask, which answers from
 * `assistant/quickQuery.ask` with its citations right here. Everywhere else it opens on
 * Everything, the cross-object index. Tab cycles, so nothing is ever out of reach.
 *
 * Typing is fuzzy (subsequence, with the matched characters highlighted), a
 * leading `>`/`@`/`#` narrows to commands/people/labels and `?` asks knowledge,
 * and an item may ask for an ARGUMENT — selecting it opens a second step with its
 * own option list instead of running. All of that arithmetic is pure
 * (`~/lib/commandPalette`); this component holds the state and the keyboard, and
 * `AppCommandPaletteResults` renders it.
 */

const props = defineProps<{
	/**
	 * The request that got this palette mounted (see `useCommandPaletteHost`):
	 * it opens with it as soon as it is mounted. Absent when mounted eagerly.
	 */
	initialOpen?: CommandPaletteOpenDetail;
}>();

const emit = defineEmits<{
	/** Mounted with its own open triggers attached; the host can stand down. */
	ready: [];
}>();

const { t } = useI18n();
const { verbItems, contextItems, navItems, settingsItems } = useCommandPaletteProviders();
const registryProviders = useCommandPaletteRegistry();
const { isEnabled: isFlagEnabled } = useFeatureFlag();
const route = useRoute();

const open = ref(false);
const activeIndex = ref(0);
const searchBar = ref<{ input: HTMLInputElement | null } | null>(null);
const inputEl = computed(() => searchBar.value?.input ?? null);
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

// ── Submenus. While an item's argument is pending the palette shows only that
// item's options; the box filters them, and Back restores the parent's query.
const argument = useCommandPaletteArgument({
	query: searchQuery,
	setQuery: (value) => setImmediate(value),
	activeIndex,
	focus: () => inputEl.value?.focus(),
	indexOf: (id) => flatIndexById.value.get(id),
});
const pendingArgument = argument.pending;

// ── Scope: which corpus this overlay is searching right now (none in a submenu).
const paletteScope = useCommandPaletteScope(() => parsedQuery.value.mode, pendingArgument);
const { scope, prompt, effectiveMode, isAskAvailable, resetScope, cycleScope } = paletteScope;

// ── Recent terms, tagged with the scope they were typed in (localStorage).
// Tagged by what the box is DOING, not by the chip: a `?` question asked from
// the Everything chip is still Ask history, and belongs with the other ones.
const { recentSearches, loadRecent, saveRecent, clearRecent } = useCommandPaletteRecents(() =>
	prompt.value === 'ask' ? 'ask' : scope.value
);
// ── The records opened last ("Jump back"), and how recently, for tie-breaks.
const objectRecents = useCommandPaletteObjectRecents();

// ── Object search (contacts / templates / campaigns / mail) via the shared index.
// Skipped outside the Everything-style palette: Mail and Ask have their own
// backends, and this component is mounted on every dashboard page.
// keepPreviousData: the last results stay listed while the next term runs,
// instead of the groups vanishing on every pause in typing. `openPalette` resets
// it, so a new session never opens on the previous one's results.
const {
	data: searchData,
	isRefetching: isGlobalSearchRefetching,
	reset: resetGlobalSearch,
} = useOrganizationQuery(
	api.search.global.search,
	() =>
		// undefined → the wrapper skips the subscription (no empty / <2-char query).
		prompt.value === 'palette' && debouncedTerm.value.trim().length >= SEARCH_MIN_QUERY
			? { query: debouncedTerm.value, limit: 5 }
			: undefined,
	{ keepPreviousData: true }
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

// ── Ask: the knowledge + files question, and in Mail scope the question to the
// person's own mail, each answered inline with citations.
const askScope = useCommandPaletteAsk();
const mailAskScope = useCommandPaletteMailAsk({ onNavigate: () => close() });

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
	return (
		searchResults.value === undefined ||
		isGlobalSearchRefetching.value ||
		searchTerm.value !== debouncedTerm.value ||
		inboxScope.isSearching.value
	);
});

// ── Core providers, consulted before any surface/plugin provider. Their
// composition (ids, priorities, group keys/orders/caps, gating) lives in the
// pure `buildCorePaletteProviders` factory and is pinned by its conformance
// suite; here we only inject the reactive reads and item `run` closures. Each
// getter is read inside `build`, so the assembling computed re-tracks them.
const coreProviders = buildCorePaletteProviders({
	jumpBackItems: () => objectRecents.jumpBackItems.value,
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
	mailStartItems: () => mailScope.startItems.value,
	mailFixItems: () => mailScope.fixItems.value,
	inboxThreadItems: () => inboxScope.threadItems.value,
});

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
	if (prompt.value === 'ask' || prompt.value === 'mailAsk') {
		return mergeGroups(resolved.filter((group) => group.key === 'recent'));
	}
	const scoped = groupsForScope(resolved, scope.value, effectiveMode.value, searchTerm.value);
	const ranked = applyRecencyTieBreak(scoped, searchTerm.value, objectRecents.recencyOf);
	return mergeGroups(groupsForMode(ranked, effectiveMode.value));
});

// What the rows highlight against: the argument step filters on the raw box,
// everything else on the prefix-stripped term.
const matchTerm = computed(() => (pendingArgument.value ? searchQuery.value : searchTerm.value));

// Only while open: the palette is mounted on every dashboard page, and the
// watcher below would otherwise rebuild every provider's groups on each route,
// flag or recents change while nobody can see them.
const flatItems = computed(() => (open.value ? flattenGroups(groups.value) : []));
const flatIndexById = computed(() => indexById(flatItems.value));
const hasAnyResults = computed(() => flatItems.value.length > 0);

/**
 * Where the highlight sits when the rows change.
 *
 * Once something is typed, Mail scope selects NOTHING: Enter runs what you
 * typed, not somebody's message, until an arrow key hands over to the list.
 * With nothing typed there is no search to run, so the first row (the record you
 * were on before this one) is selected, like everywhere else.
 */
const restingIndex = computed(() =>
	prompt.value === 'mailSearch' && searchTerm.value.trim() ? -1 : 0
);
watch(flatItems, () => {
	activeIndex.value = restingIndex.value;
});

const scopeLabel = computed(() => t(PALETTE_SCOPE_LABEL_KEYS[scope.value]));

// The rows, the spinner and the answers repaint silently, and focus stays in
// the box: say what a search found and when an answer arrives.
const { announce } = useAnnounce();
watch([() => open.value && !isSearching.value, debouncedTerm], ([settled, term]) => {
	if (!settled || pendingArgument.value || term.trim().length < SEARCH_MIN_QUERY) return;
	if (prompt.value === 'ask' || prompt.value === 'mailAsk') return;
	const count = flatItems.value.length;
	announce(
		count > 0
			? t('components.appCommandPalette.resultCount', { count }, count)
			: t('components.appCommandPalette.noResults', { query: term.trim() })
	);
});
watch(
	() => (open.value ? (askScope.answer.value ?? mailAskScope.answer.value) : null),
	(answer, previous) => {
		if (answer && answer !== previous) announce(t('components.appCommandPalette.answerReady'));
	}
);
/** An answer on screen has citations to reach, so Tab leaves the box for it. */
const hasAnswerOnScreen = computed(
	() =>
		(prompt.value === 'ask' && !!askScope.answer.value) ||
		(prompt.value === 'mailAsk' && !!mailAskScope.answer.value)
);

function syncCaret() {
	caret.value = inputEl.value?.selectionStart ?? searchQuery.value.length;
}

async function openPalette(detail?: CommandPaletteOpenDetail) {
	// A caller may hand over the query to refine (the mail search page's box).
	const initialQuery = detail?.query ?? '';
	open.value = true;
	setImmediate(initialQuery);
	activeIndex.value = restingIndex.value;
	caret.value = initialQuery.length;
	argument.reset();
	resetScope(detail?.scope);
	resetGlobalSearch();
	mailScope.resetQuery(initialQuery);
	inboxScope.resetQuery();
	askScope.reset();
	mailAskScope.reset();
	loadRecent();
	objectRecents.load();
	await nextTick();
	inputEl.value?.focus();
	inputEl.value?.setSelectionRange(initialQuery.length, initialQuery.length);
}

function close() {
	open.value = false;
	searchQuery.value = '';
	activeIndex.value = 0;
	argument.reset();
	mailScope.resetQuery();
	inboxScope.resetQuery();
	askScope.reset();
	mailAskScope.reset();
}

function runItem(item: PaletteItem | undefined) {
	if (!item) return;
	// Two-step: ask for the argument instead of running. `run` never fires for an
	// item that has one, so a provider can leave it as a no-op.
	if (argument.enter(item)) return;
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
	if (prompt.value === 'ask' || prompt.value === 'mailAsk') {
		saveRecent(searchTerm.value);
		void (prompt.value === 'ask' ? askScope : mailAskScope).ask(searchTerm.value);
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
	// Mid-composition, Enter and the arrows belong to the IME.
	if (isImeComposing(event)) return;
	if (event.key === 'Escape') {
		event.preventDefault();
		// Escape unwinds one level at a time: out of the submenu first.
		if (!argument.back()) close();
		return;
	}
	// Backspacing past the start of an empty submenu query also backs out, the
	// way a deleted chip behaves everywhere else in the app.
	if (event.key === 'Backspace' && pendingArgument.value && searchQuery.value === '') {
		event.preventDefault();
		argument.back();
		return;
	}
	// Tab cycles the SCOPE rather than moving focus: the overlay is one input, and
	// the argument step is a sub-list of one scope, so it opts out. With an answer
	// on screen Tab moves focus as usual, into the answer's sources, and the focus
	// trap keeps it inside the palette.
	if (event.key === 'Tab' && !pendingArgument.value && !hasAnswerOnScreen.value) {
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
// `ai.knowledge` flag the panel it replaced was gated on. Header/mobile search
// buttons, the desktop titlebar pill and the Postbox `/` shortcut send the open
// event (the detail names a scope when the caller has one), and the palette's
// own "Ask knowledge…" verb switches this overlay instead of opening a modal.
let detachTriggers: (() => void) | null = null;
onMounted(() => {
	loadRecent();
	detachTriggers = listenForCommandPaletteTriggers(
		{
			toggle: () => {
				if (open.value) close();
				else void openPalette();
			},
			ask: () => void openPalette({ scope: 'ask' }),
			open: (detail) => {
				if (!open.value) void openPalette(detail);
			},
		},
		() => isAskAvailable.value
	);
	emit('ready');
	if (props.initialOpen) void openPalette(props.initialOpen);
});
onBeforeUnmount(() => detachTriggers?.());
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
			<div v-if="open" class="fixed inset-0 bg-scrim/50 z-(--z-modal)" @click="close" />
		</Transition>

		<Transition
			enter-active-class="transition-[opacity,scale] duration-(--motion-moderate)"
			enter-from-class="opacity-0 scale-95"
			enter-to-class="opacity-100 scale-100"
			leave-active-class="transition-[opacity,scale] duration-(--motion-moderate-exit)"
			leave-from-class="opacity-100 scale-100"
			leave-to-class="opacity-0 scale-95"
		>
			<div
				v-if="open"
				ref="dialogRef"
				role="dialog"
				aria-modal="true"
				:aria-label="t('components.appCommandPalette.dialogLabel')"
				class="fixed inset-x-4 top-[12%] mx-auto max-w-xl xl:max-w-2xl bg-bg-elevated rounded-xl shadow-surface-6 z-(--z-modal) overflow-hidden"
			>
				<!-- Search input -->
				<AppCommandPaletteSearchBar
					ref="searchBar"
					v-model:query="searchQuery"
					:scope-label="scopeLabel"
					:pending-prompt-key="pendingArgument?.spec.promptKey ?? null"
					:placeholder-key="paletteScope.placeholderKey.value"
					:active-descendant="flatItems[activeIndex] ? `app-cmdk-opt-${activeIndex}` : undefined"
					@keydown="onInputKeydown"
					@caret="syncCaret"
					@cycle-scope="cycleScope"
				/>

				<AppCommandPaletteResults
					:groups="groups"
					:active-index="activeIndex"
					:index-by-id="flatIndexById"
					:match-term="matchTerm"
					:prompt="prompt"
					:is-searching="isSearching"
					:has-rows="hasAnyResults"
					:ask-available="isAskAvailable"
					:ask-answer="askScope.answer.value"
					:ask-loading="askScope.isLoading.value"
					:mail-ask-available="paletteScope.isMailAskAvailable.value"
					:mail-ask-answer="mailAskScope.answer.value"
					:mail-ask-loading="mailAskScope.isLoading.value"
					@run="runItem"
					@hover="activeIndex = $event"
					@clear-recent="clearRecent"
					@open-citation="mailAskScope.openCitation"
				/>

				<AppCommandPaletteFooter :pending-argument="!!pendingArgument" />
			</div>
		</Transition>
	</Teleport>
</template>
