<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	type PaletteArgumentSpec,
	type PaletteGroup,
	type PaletteItem,
	buildArgumentGroups,
	flattenGroups,
	groupsForMode,
	highlightSegments,
	mergeGroups,
	moveSelection,
	parsePaletteQuery,
} from '~/lib/commandPalette';
import { resolvePaletteGroups } from '~/lib/commandPaletteRegistry';
import {
	SEARCH_MIN_QUERY,
	type SearchResult,
	type SearchResults,
	buildCorePaletteProviders,
} from '~/lib/commandPaletteCore';

/**
 * App-wide Cmd/Ctrl-K command palette, mounted once in the dashboard layout so
 * it works on EVERY dashboard page. Assembled from an ordered, deduplicated
 * provider registry (`~/lib/commandPaletteRegistry`):
 *   1. core providers, built here and consulted first — recent searches, verbs,
 *      sidebar-context switch, object search, mail, and navigation;
 *   2. surface/plugin providers registered while mounted (e.g. the Postbox
 *      layout registers its reader actions + folders, route-gated to Postbox).
 *
 * Providers are gated by feature flag and route, ordered by priority, and
 * deduplicated by group key and item id (earlier providers win) before the
 * `mergeGroups` sort/cap. The palette is the shared shell; every contributor —
 * core or plugin — flows through the same registry, so nothing forks it.
 *
 * Typing is fuzzy (subsequence, with the matched characters highlighted), a
 * leading `>`/`@`/`#` narrows to commands/people/labels, and an item may ask
 * for an ARGUMENT — selecting it opens a second step with its own option list
 * instead of running. All of that arithmetic is pure (`~/lib/commandPalette`);
 * this component only holds the state and renders it.
 *
 * The Cmd+Shift+K knowledge Quick Query keeps its own shortcut; it is surfaced
 * here as the "Ask knowledge…" action (dispatches `owlat:open-knowledge-query`,
 * which the layout listens for).
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

// Debounced so each keystroke doesn't re-run the cross-table search query.
const { searchQuery, debouncedSearch, setImmediate } = useDebouncedSearch(300);

// Tab trap + opener restore, shared with the modal dialogs. Escape/Arrow/Enter
// are handled by onInputKeydown below (single source of truth).
useModalFocus(dialogRef, () => open.value);

// ── Recent object-search terms (localStorage-backed; see the composable).
const { recentSearches, loadRecent, saveRecent, clearRecent } = useCommandPaletteRecents();

// ── Mode prefixes: the typed `>`/`@`/`#` never reaches a provider or the search
// index — providers see the bare term, and the mode filters the merged groups.
const parsedQuery = computed(() => parsePaletteQuery(searchQuery.value));
const searchTerm = computed(() => parsedQuery.value.term);
const debouncedTerm = computed(() => parsePaletteQuery(debouncedSearch.value).term);

// ── Object search (contacts / templates / campaigns / mail) via the shared index.
const { data: searchData } = useOrganizationQuery(api.globalSearch.search, () =>
	// undefined → the wrapper skips the subscription (no empty / <2-char query).
	debouncedTerm.value.trim().length >= SEARCH_MIN_QUERY
		? { query: debouncedTerm.value, limit: 5 }
		: undefined
);
const searchResults = computed(() => searchData.value as SearchResults | undefined);
const isSearching = computed(
	() => searchTerm.value.trim().length >= SEARCH_MIN_QUERY && searchResults.value === undefined
);

function iconForType(type: string): string {
	if (type === 'contact') return 'lucide:user';
	if (type === 'campaign') return 'lucide:megaphone';
	return 'lucide:mail';
}

function toResultItems(results: SearchResult[]): PaletteItem[] {
	return results.map((result) => ({
		id: `search:${result.id}`,
		label: result.title,
		subtitle: result.subtitle,
		icon: iconForType(result.type),
		run: () => {
			saveRecent(searchTerm.value);
			void navigateTo(result.url);
		},
	}));
}

// ── Mail hits. Selecting one may cross mailboxes, so the active Postbox mailbox
// is pointed at the message's own mailbox before navigating — otherwise the
// thread opens against whichever mailbox happened to be selected and reads as
// "not found". The selection composable is the state-only one: this component
// is mounted on every dashboard page and must not open Postbox subscriptions.
const { setActiveMailboxId } = usePostboxActiveMailbox();

function toMailItems(results: SearchResult[]): PaletteItem[] {
	return results.map((result) => ({
		id: `mail:${result.id}`,
		label: result.title.trim() || t('components.appCommandPalette.noSubject'),
		subtitle: result.subtitle,
		icon: 'lucide:mail',
		run: () => {
			saveRecent(searchTerm.value);
			if (result.mailboxId) setActiveMailboxId(result.mailboxId as Id<'mailboxes'>);
			void navigateTo(result.url);
		},
	}));
}

function toSearchMailItem(term: string): PaletteItem {
	return {
		id: 'mail:search-for',
		label: t('components.appCommandPalette.searchMailFor', { query: term }),
		icon: 'lucide:search',
		run: () => {
			saveRecent(term);
			void navigateTo({ path: '/dashboard/postbox/search', query: { q: term } });
		},
	};
}

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
	onRecentTerm: (term) => setImmediate(term),
	buildResultItems: (results) => toResultItems(results),
	buildMailItems: (results) => toMailItems(results),
	buildSearchMailItem: (term) => toSearchMailItem(term),
});

// ── Argument step. While an item's argument is pending the palette shows only
// that item's options; the query box filters them and Escape backs out.
const pendingArgument = ref<{ item: PaletteItem; spec: PaletteArgumentSpec } | null>(null);

// ── Assemble the ordered, capped group list: gate + order + dedup providers,
// keep the groups the typed mode admits, then sort/drop-empties/cap. Core
// providers form their own trust tier and are always consulted before any
// registered surface/plugin provider, so a registered provider can add work but
// never override a core group or item.
const groups = computed<PaletteGroup[]>(() => {
	const pending = pendingArgument.value;
	if (pending) return mergeGroups(buildArgumentGroups(pending.spec, searchQuery.value));
	return mergeGroups(
		groupsForMode(
			resolvePaletteGroups(
				coreProviders,
				registryProviders.value,
				{ path: route.path, isFlagEnabled },
				{ query: searchTerm.value, mode: parsedQuery.value.mode }
			),
			parsedQuery.value.mode
		)
	);
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

watch(flatItems, () => {
	activeIndex.value = 0;
});

async function openPalette() {
	open.value = true;
	searchQuery.value = '';
	activeIndex.value = 0;
	pendingArgument.value = null;
	loadRecent();
	await nextTick();
	inputEl.value?.focus();
}

function close() {
	open.value = false;
	searchQuery.value = '';
	activeIndex.value = 0;
	pendingArgument.value = null;
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
	if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
		event.preventDefault();
		activeIndex.value = moveSelection(activeIndex.value, event.key, flatItems.value.length);
	} else if (event.key === 'Enter') {
		event.preventDefault();
		runItem(flatItems.value[activeIndex.value]);
	}
}

// ── Global open triggers. This palette owns plain Cmd/Ctrl+K everywhere;
// Cmd+Shift+K stays with the knowledge Quick Query (dashboard layout).
function onGlobalKey(event: KeyboardEvent) {
	if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'k') {
		event.preventDefault();
		if (open.value) close();
		else void openPalette();
	}
}

// Header/mobile search buttons open us.
function onExternalOpen() {
	if (!open.value) void openPalette();
}

onMounted(() => {
	loadRecent();
	window.addEventListener('keydown', onGlobalKey);
	window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onExternalOpen);
});
onBeforeUnmount(() => {
	window.removeEventListener('keydown', onGlobalKey);
	window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onExternalOpen);
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
				class="fixed inset-x-4 top-[12%] mx-auto max-w-xl bg-bg-elevated border border-border-default rounded-xl shadow-8 z-50 overflow-hidden"
			>
				<!-- Search input -->
				<div class="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
					<Icon name="lucide:search" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
					<span
						v-if="pendingArgument"
						class="flex-shrink-0 text-xs px-2 py-1 rounded bg-bg-surface text-text-secondary"
					>
						{{ t(pendingArgument.spec.promptKey) }}
					</span>
					<input
						ref="inputEl"
						v-model="searchQuery"
						type="text"
						:placeholder="t('components.appCommandPalette.searchPlaceholder')"
						class="flex-1 bg-transparent text-text-primary placeholder-text-tertiary outline-none text-base"
						role="combobox"
						aria-expanded="true"
						aria-controls="app-cmdk-list"
						:aria-label="t('components.appCommandPalette.dialogLabel')"
						:aria-activedescendant="
							flatItems[activeIndex] ? `app-cmdk-opt-${activeIndex}` : undefined
						"
						@keydown="onInputKeydown"
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

				<!-- Results -->
				<div id="app-cmdk-list" role="listbox" class="max-h-[60vh] overflow-y-auto py-2">
					<div
						v-if="isSearching && !hasAnyResults"
						class="px-4 py-8 text-center text-text-tertiary"
					>
						<UiSpinner class="mx-auto" size="sm" tone="brand" />
						<p class="mt-2 text-sm">{{ t('components.appCommandPalette.searching') }}</p>
					</div>

					<div v-else-if="!hasAnyResults" class="px-4 py-8 text-center text-text-tertiary">
						<Icon name="lucide:search" class="w-8 h-8 mx-auto mb-2 opacity-50" />
						<p class="text-sm">
							{{
								searchTerm.trim().length >= SEARCH_MIN_QUERY
									? t('components.appCommandPalette.noResults', { query: searchTerm })
									: t('components.appCommandPalette.noMatches')
							}}
						</p>
					</div>

					<div v-for="group in groups" v-else :key="group.key" class="mb-1">
						<div
							class="flex items-center justify-between px-4 py-1.5 text-xs font-medium text-text-tertiary uppercase tracking-wider"
						>
							<!-- Provider group headings are message keys (providers are pure
							     module-scope registries and cannot call `useI18n`); a heading a
							     provider still ships as literal text passes through unchanged. -->
							<span>{{ t(group.heading) }}</span>
							<button
								v-if="group.key === 'recent'"
								class="text-xs normal-case tracking-normal text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast)"
								@click="clearRecent"
							>
								{{ t('components.appCommandPalette.clearRecent') }}
							</button>
						</div>
						<button
							v-for="item in group.items"
							:id="`app-cmdk-opt-${flatIndexById.get(item.id)}`"
							:key="item.id"
							type="button"
							role="option"
							:aria-selected="flatIndexById.get(item.id) === activeIndex"
							class="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-(--motion-fast)"
							:class="
								flatIndexById.get(item.id) === activeIndex
									? 'bg-bg-surface text-text-primary'
									: 'hover:bg-bg-surface text-text-secondary'
							"
							@click="runItem(item)"
							@mousemove="activeIndex = flatIndexById.get(item.id) ?? activeIndex"
						>
							<Icon :name="item.icon" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
							<span class="flex-1 min-w-0">
								<span class="block text-sm truncate">
									<!-- The fuzzy scorer matched these characters; bolding them is what
									     makes a subsequence hit ("pbx" → Postbox) legible. -->
									<span
										v-for="(segment, segmentIndex) in highlightSegments(item.label, matchTerm)"
										:key="segmentIndex"
										:class="segment.isMatch ? 'font-semibold text-text-primary' : undefined"
										>{{ segment.text }}</span
									>
								</span>
								<span v-if="item.subtitle" class="block text-xs text-text-tertiary truncate">{{
									item.subtitle
								}}</span>
							</span>
							<Icon
								v-if="item.argument"
								name="lucide:chevron-right"
								class="w-4 h-4 flex-shrink-0 text-text-tertiary"
							/>
							<kbd
								v-else-if="item.hint"
								class="text-2xs text-text-tertiary border border-border-subtle rounded px-1"
								>{{ item.hint }}</kbd
							>
						</button>
					</div>
				</div>

				<!-- Footer -->
				<div
					class="px-4 py-2 border-t border-border-subtle bg-bg-surface text-xs text-text-tertiary flex items-center gap-4"
				>
					<span class="flex items-center gap-1">
						<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-2xs"
							>↑↓</kbd
						>
						{{ t('components.appCommandPalette.navigate') }}
					</span>
					<span class="flex items-center gap-1">
						<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-2xs"
							>↵</kbd
						>
						{{ t('components.appCommandPalette.select') }}
					</span>
					<span class="flex items-center gap-1">
						<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-2xs"
							>esc</kbd
						>
						{{ pendingArgument ? t('components.appCommandPalette.back') : t('common.close') }}
					</span>
					<span v-if="!pendingArgument" class="hidden sm:flex items-center gap-1">
						<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-2xs"
							>&gt; @ #</kbd
						>
						{{ t('components.appCommandPalette.modeHint') }}
					</span>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>
