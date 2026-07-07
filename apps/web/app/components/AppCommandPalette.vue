<script setup lang="ts">
import { api } from '@owlat/api';
import {
	type PaletteGroup,
	type PaletteItem,
	filterItems,
	flattenGroups,
	mergeGroups,
	moveSelection,
	useCommandPaletteSurface,
} from '~/lib/commandPalette';

/**
 * App-wide Cmd/Ctrl-K command palette, mounted once in the dashboard layout so
 * it works on EVERY dashboard page. Assembled from ordered providers:
 *   1. current-surface actions — contributed by the active surface (e.g. the
 *      Postbox layout registers its reader actions + folders) via
 *      `useCommandPaletteSurface`; the palette is the shared shell, surfaces are
 *      consumers (no per-surface fork);
 *   2. verbs — New campaign, Compose, New contact…;
 *   3. object search — contacts / templates / campaigns via the existing
 *      `globalSearch` search index (debounced, capped per group);
 *   4. navigation — every sidebar destination (shared `useDashboardNavigation`).
 *
 * The Cmd+Shift+K knowledge Quick Query keeps its own shortcut; it is surfaced
 * here as the "Ask knowledge…" action (dispatches `owlat:open-knowledge-query`,
 * which the layout listens for).
 */

const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const { isDesktop } = useDesktopContext();
const { navigationSections } = useDashboardNavigation();
const surfaceGroups = useCommandPaletteSurface();

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
const MAX_RECENT = 5;
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
		MAX_RECENT
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
type SearchResult = { id: string; type: string; title: string; subtitle: string; url: string };
type SearchResults = {
	contacts: SearchResult[];
	emails: SearchResult[];
	campaigns: SearchResult[];
};

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

// ── Static verb + utility providers.
const verbItems = computed<PaletteItem[]>(() => {
	const verbs: PaletteItem[] = [];
	if (isFeatureEnabled('campaigns')) {
		verbs.push({
			id: 'verb:new-campaign',
			label: 'New campaign',
			icon: 'lucide:megaphone',
			run: () => void navigateTo('/dashboard/campaigns/new'),
		});
	}
	if (isFeatureEnabled('postbox') || isFeatureEnabled('mail.external')) {
		verbs.push({
			id: 'verb:compose',
			label: 'Compose message',
			icon: 'lucide:pencil',
			run: () => void navigateTo('/dashboard/postbox/inbox'),
		});
	}
	verbs.push({
		id: 'verb:new-contact',
		label: 'New contact',
		icon: 'lucide:user-plus',
		run: () => void navigateTo('/dashboard/audience/contacts'),
	});
	if (isFeatureEnabled('ai.knowledge')) {
		verbs.push({
			id: 'verb:ask-knowledge',
			label: 'Ask knowledge…',
			subtitle: 'Search your knowledge base',
			icon: 'lucide:sparkles',
			run: () => window.dispatchEvent(new Event('owlat:open-knowledge-query')),
		});
	}
	if (isDesktop.value) {
		verbs.push({
			id: 'verb:check-updates',
			label: 'Check for updates',
			icon: 'lucide:download-cloud',
			run: () => window.dispatchEvent(new Event('owlat:check-updates')),
		});
	}
	return verbs;
});

const navItems = computed<PaletteItem[]>(() =>
	navigationSections.value.flatMap((section) =>
		section.items.map((item) => ({
			id: `nav:${item.href}`,
			label: item.name,
			subtitle: section.name,
			icon: item.icon,
			run: () => void navigateTo(item.href),
		}))
	)
);

// ── Assemble the ordered, capped group list.
const groups = computed<PaletteGroup[]>(() => {
	const query = searchQuery.value;
	const idle = query.trim().length < 2;
	const out: PaletteGroup[] = [];

	// Recent searches — only in the idle state, above everything.
	if (idle && recentSearches.value.length > 0) {
		out.push({
			key: 'recent',
			heading: 'Recent searches',
			order: -1,
			cap: MAX_RECENT,
			items: recentSearches.value.map((term) => ({
				id: `recent:${term}`,
				label: term,
				icon: 'lucide:clock',
				keepOpen: true,
				run: () => setImmediate(term),
			})),
		});
	}

	// Current-surface actions (e.g. Postbox), filtered by the query.
	for (const group of surfaceGroups.value) {
		out.push({ ...group, items: filterItems(group.items, query) });
	}

	// Verbs / utilities.
	out.push({
		key: 'verbs',
		heading: 'Create',
		order: 5,
		items: filterItems(verbItems.value, query),
	});

	// Object search — only once the query is meaningful.
	const results = searchResults.value;
	if (!idle && results) {
		out.push({
			key: 'contacts',
			heading: 'Contacts',
			order: 20,
			cap: 5,
			items: toResultItems(results.contacts),
		});
		out.push({
			key: 'campaigns',
			heading: 'Campaigns',
			order: 21,
			cap: 5,
			items: toResultItems(results.campaigns),
		});
		out.push({
			key: 'templates',
			heading: 'Templates',
			order: 22,
			cap: 5,
			items: toResultItems(results.emails),
		});
	}

	// Navigation — every sidebar destination.
	out.push({
		key: 'navigation',
		heading: 'Go to',
		order: 40,
		cap: 8,
		items: filterItems(navItems.value, query),
	});

	return mergeGroups(out);
});

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

// Header/mobile search buttons + desktop OS-global shortcut both open us.
function onExternalOpen() {
	if (!open.value) void openPalette();
}

onMounted(() => {
	loadRecent();
	window.addEventListener('keydown', onGlobalKey);
	window.addEventListener('owlat:quick-switcher', onExternalOpen);
	window.addEventListener('owlat:command-palette-open', onExternalOpen);
});
onBeforeUnmount(() => {
	window.removeEventListener('keydown', onGlobalKey);
	window.removeEventListener('owlat:quick-switcher', onExternalOpen);
	window.removeEventListener('owlat:command-palette-open', onExternalOpen);
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
						<div
							class="animate-spin w-5 h-5 border-2 border-text-tertiary border-t-brand rounded-full mx-auto"
						/>
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
