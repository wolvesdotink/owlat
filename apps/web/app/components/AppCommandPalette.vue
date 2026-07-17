<script setup lang="ts">
import { api } from '@owlat/api';
import {
	type PaletteGroup,
	type PaletteItem,
	flattenGroups,
	mergeGroups,
	moveSelection,
} from '~/lib/commandPalette';
import { resolvePaletteGroups } from '~/lib/commandPaletteRegistry';
import {
	MAX_RECENT_SEARCHES,
	type SearchResult,
	type SearchResults,
	buildCorePaletteProviders,
} from '~/lib/commandPaletteCore';

/**
 * App-wide Cmd/Ctrl-K command palette, mounted once in the dashboard layout so
 * it works on EVERY dashboard page. Assembled from an ordered, deduplicated
 * provider registry (`~/lib/commandPaletteRegistry`):
 *   1. core providers, built here and consulted first — recent searches, verbs,
 *      sidebar-context switch, object search, and navigation;
 *   2. surface/plugin providers registered while mounted (e.g. the Postbox
 *      layout registers its reader actions + folders, route-gated to Postbox).
 *
 * Providers are gated by feature flag and route, ordered by priority, and
 * deduplicated by group key and item id (earlier providers win) before the
 * `mergeGroups` sort/cap. The palette is the shared shell; every contributor —
 * core or plugin — flows through the same registry, so nothing forks it.
 *
 * The Cmd+Shift+K knowledge Quick Query keeps its own shortcut; it is surfaced
 * here as the "Ask knowledge…" action (dispatches `owlat:open-knowledge-query`,
 * which the layout listens for).
 */

const { verbItems, contextItems, navItems } = useCommandPaletteProviders();
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

// ── Recent object-search queries (carried over from the old GlobalSearch modal)
const RECENT_KEY = 'owlat_recent_searches';
const recentSearches = ref<string[]>([]);

function loadRecent() {
	if (import.meta.server) return;
	try {
		const stored = localStorage.getItem(RECENT_KEY);
		recentSearches.value = stored ? (JSON.parse(stored) as string[]) : [];
	} catch {
		recentSearches.value = [];
	}
}

function saveRecent(term: string) {
	const trimmed = term.trim();
	if (!trimmed || import.meta.server) return;
	recentSearches.value = [trimmed, ...recentSearches.value.filter((s) => s !== trimmed)].slice(
		0,
		MAX_RECENT_SEARCHES
	);
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(recentSearches.value));
	} catch {
		// Ignore quota / disabled storage.
	}
}

function clearRecent() {
	recentSearches.value = [];
	if (import.meta.client) {
		try {
			localStorage.removeItem(RECENT_KEY);
		} catch {
			// Ignore.
		}
	}
}

// ── Object search (contacts / templates / campaigns) via the shared index.
const { data: searchData } = useOrganizationQuery(api.globalSearch.search, () =>
	// undefined → the wrapper skips the subscription (no empty / <2-char query).
	debouncedSearch.value.trim().length >= 2 ? { query: debouncedSearch.value, limit: 5 } : undefined
);
const searchResults = computed(() => searchData.value as SearchResults | undefined);
const isSearching = computed(
	() => searchQuery.value.trim().length >= 2 && searchResults.value === undefined
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
			saveRecent(searchQuery.value);
			void navigateTo(result.url);
		},
	}));
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
	searchResults: () => searchResults.value,
	onRecentTerm: (term) => setImmediate(term),
	buildResultItems: (results) => toResultItems(results),
});

// ── Assemble the ordered, capped group list: gate + order + dedup providers,
// then sort/drop-empties/cap. Core providers form their own trust tier and are
// always consulted before any registered surface/plugin provider, so a
// registered provider can add work but never override a core group or item.
const groups = computed<PaletteGroup[]>(() =>
	mergeGroups(
		resolvePaletteGroups(
			coreProviders,
			registryProviders.value,
			{ path: route.path, isFlagEnabled },
			{ query: searchQuery.value }
		)
	)
);

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
	loadRecent();
	await nextTick();
	inputEl.value?.focus();
}

function close() {
	open.value = false;
	searchQuery.value = '';
	activeIndex.value = 0;
}

function runItem(item: PaletteItem | undefined) {
	if (!item) return;
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
		close();
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
			<div v-if="open" class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50" @click="close" />
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
				aria-label="Command palette"
				class="fixed inset-x-4 top-[12%] mx-auto max-w-xl bg-bg-elevated border border-border-default rounded-xl shadow-8 z-50 overflow-hidden"
			>
				<!-- Search input -->
				<div class="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
					<Icon name="lucide:search" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
					<input
						ref="inputEl"
						v-model="searchQuery"
						type="text"
						placeholder="Search or run a command…"
						class="flex-1 bg-transparent text-text-primary placeholder-text-tertiary outline-none text-base"
						role="combobox"
						aria-expanded="true"
						aria-controls="app-cmdk-list"
						:aria-activedescendant="
							flatItems[activeIndex] ? `app-cmdk-opt-${activeIndex}` : undefined
						"
						aria-label="Command palette"
						@keydown="onInputKeydown"
					/>
					<button
						v-if="searchQuery"
						class="p-1 text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast)"
						aria-label="Clear"
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
						<p class="mt-2 text-sm">Searching…</p>
					</div>

					<div v-else-if="!hasAnyResults" class="px-4 py-8 text-center text-text-tertiary">
						<Icon name="lucide:search" class="w-8 h-8 mx-auto mb-2 opacity-50" />
						<p class="text-sm">
							{{
								searchQuery.trim().length >= 2 ? `No results for "${searchQuery}"` : 'No matches'
							}}
						</p>
					</div>

					<div v-for="group in groups" v-else :key="group.key" class="mb-1">
						<div
							class="flex items-center justify-between px-4 py-1.5 text-xs font-medium text-text-tertiary uppercase tracking-wider"
						>
							<span>{{ group.heading }}</span>
							<button
								v-if="group.key === 'recent'"
								class="text-xs normal-case tracking-normal text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast)"
								@click="clearRecent"
							>
								Clear
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
								<span class="block text-sm truncate">{{ item.label }}</span>
								<span v-if="item.subtitle" class="block text-xs text-text-tertiary truncate">{{
									item.subtitle
								}}</span>
							</span>
							<kbd
								v-if="item.hint"
								class="text-[10px] text-text-tertiary border border-border-subtle rounded px-1"
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
						<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-[10px]"
							>↑↓</kbd
						>
						Navigate
					</span>
					<span class="flex items-center gap-1">
						<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-[10px]"
							>↵</kbd
						>
						Select
					</span>
					<span class="flex items-center gap-1">
						<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-[10px]"
							>esc</kbd
						>
						Close
					</span>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>
