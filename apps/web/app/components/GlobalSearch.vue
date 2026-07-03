<script setup lang="ts">
import { api } from '@owlat/api';
import { ownsGlobalSwitcher, usePostboxPaletteMounted } from '~/lib/globalSwitcher';

const isOpen = ref(false);
// Debounced so each keystroke doesn't re-run the cross-table search query.
const { searchQuery, debouncedSearch } = useDebouncedSearch(300);
const dialogRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);
const selectedIndex = ref(0);

// Tab trap + opener restore, shared with UiModal and the chat dialogs. Escape is
// already handled by handleKeydown below (which also drives Arrow/Enter), so we
// opt out of the composable's Escape to keep a single source of truth.
useModalFocus(dialogRef, () => isOpen.value);
const { isPending: authPending, isAuthenticated } = useAuth();

// Recent searches stored in localStorage
const recentSearches = ref<string[]>([]);
const RECENT_SEARCHES_KEY = 'owlat_recent_searches';
const MAX_RECENT_SEARCHES = 5;

// Search result type
type SearchResult = {
	id: string;
	type: 'contact' | 'email' | 'campaign';
	title: string;
	subtitle: string;
	url: string;
};

type SearchResults = {
	contacts: SearchResult[];
	emails: SearchResult[];
	campaigns: SearchResult[];
};

// Search results from Convex
const { data: searchResultsData } = useOrganizationQuery(api.globalSearch.search, () =>
	// undefined → the wrapper skips the subscription (no empty < 2-char query).
	debouncedSearch.value.length >= 2 ? { query: debouncedSearch.value, limit: 5 } : undefined,
);

// Type cast the data
const searchResults = computed(() => searchResultsData.value as SearchResults | undefined);

// Flatten results for keyboard navigation
const flatResults = computed(() => {
	if (!searchResults.value) return [] as SearchResult[];
	const results: SearchResult[] = [];

	if (searchResults.value.contacts?.length) {
		results.push(...searchResults.value.contacts);
	}
	if (searchResults.value.emails?.length) {
		results.push(...searchResults.value.emails);
	}
	if (searchResults.value.campaigns?.length) {
		results.push(...searchResults.value.campaigns);
	}

	return results;
});

// Check if we have any results
const hasResults = computed(() => flatResults.value.length > 0);

// Open modal and focus input
const openSearch = () => {
	isOpen.value = true;
	searchQuery.value = '';
	selectedIndex.value = 0;
	loadRecentSearches();
	nextTick(() => {
		searchInputRef.value?.focus();
	});
};

// Close modal
const closeSearch = () => {
	isOpen.value = false;
	searchQuery.value = '';
	selectedIndex.value = 0;
};

// Load recent searches from localStorage
const loadRecentSearches = () => {
	if (import.meta.client) {
		try {
			const stored = localStorage.getItem(RECENT_SEARCHES_KEY);
			recentSearches.value = stored ? JSON.parse(stored) : [];
		} catch {
			recentSearches.value = [];
		}
	}
};

// Save recent search
const saveRecentSearch = (query: string) => {
	if (!query.trim() || import.meta.server) return;

	const trimmed = query.trim();
	// Remove if already exists (to move to front)
	const filtered = recentSearches.value.filter((s) => s !== trimmed);
	// Add to front
	filtered.unshift(trimmed);
	// Keep only max items
	recentSearches.value = filtered.slice(0, MAX_RECENT_SEARCHES);

	try {
		localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recentSearches.value));
	} catch {
		// Ignore localStorage errors
	}
};

// Clear recent searches
const clearRecentSearches = () => {
	recentSearches.value = [];
	if (import.meta.client) {
		try {
			localStorage.removeItem(RECENT_SEARCHES_KEY);
		} catch {
			// Ignore localStorage errors
		}
	}
};

// Navigate to result
const router = useRouter();
const navigateToResult = (url: string) => {
	if (searchQuery.value.trim()) {
		saveRecentSearch(searchQuery.value);
	}
	closeSearch();
	router.push(url);
};

// Navigate using keyboard
const handleKeydown = (e: KeyboardEvent) => {
	if (!isOpen.value) return;

	switch (e.key) {
		case 'ArrowDown':
			e.preventDefault();
			if (flatResults.value.length > 0) {
				selectedIndex.value = Math.min(selectedIndex.value + 1, flatResults.value.length - 1);
			}
			break;
		case 'ArrowUp':
			e.preventDefault();
			if (flatResults.value.length > 0) {
				selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
			}
			break;
		case 'Enter': {
			e.preventDefault();
			const selectedResult = flatResults.value[selectedIndex.value];
			if (selectedResult) {
				navigateToResult(selectedResult.url);
			}
			break;
		}
		case 'Escape':
			e.preventDefault();
			closeSearch();
			break;
	}
};

// Use recent search
const useRecentSearch = (query: string) => {
	searchQuery.value = query;
	selectedIndex.value = 0;
	nextTick(() => {
		searchInputRef.value?.focus();
	});
};

// Reset selected index when results change
watch(flatResults, () => {
	selectedIndex.value = 0;
});

// Global keyboard shortcut (Cmd+K / Ctrl+K).
// Shift chords belong to Quick Query (Cmd+Shift+K, dashboard layout). When a
// PostboxCommandPalette is mounted it owns Cmd+K — both listen globally, and
// preventDefault does not stop a sibling listener — so we defer iff one is
// present (mount count > 0).
const postboxPaletteMounted = usePostboxPaletteMounted();
const handleGlobalKeydown = (e: KeyboardEvent) => {
	if (!ownsGlobalSwitcher(postboxPaletteMounted.value)) return;
	if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
		e.preventDefault();
		if (isOpen.value) {
			closeSearch();
		} else {
			openSearch();
		}
	}
};

// OS-global shortcut bridge (desktop). useDesktopShortcuts re-dispatches the
// Rust Cmd/Ctrl+K (incl. tray summon / another app focused) as this window
// event. When a PostboxCommandPalette is mounted it owns this event, so we
// defer iff one is present — mirroring the presence guard above.
const handleQuickSwitcher = () => {
	if (!ownsGlobalSwitcher(postboxPaletteMounted.value)) return;
	if (!isOpen.value) openSearch();
};

// Register/unregister global keyboard listener
onMounted(() => {
	document.addEventListener('keydown', handleGlobalKeydown);
	window.addEventListener('owlat:quick-switcher', handleQuickSwitcher);
	loadRecentSearches();
});

onUnmounted(() => {
	document.removeEventListener('keydown', handleGlobalKeydown);
	window.removeEventListener('owlat:quick-switcher', handleQuickSwitcher);
});

// Expose openSearch for external use
defineExpose({ openSearch });
</script>

<template>
	<!-- Search trigger button -->
	<button
		class="flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:text-text-primary bg-bg-surface hover:bg-bg-surface-hover border border-border-subtle rounded-lg transition-colors"
		@click="openSearch"
	>
		<Icon name="lucide:search" class="w-4 h-4" />
		<span class="hidden sm:inline">Search...</span>
		<kbd
			class="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary bg-bg-elevated border border-border-subtle rounded"
		>
			<span class="text-xs">⌘</span>K
		</kbd>
	</button>

	<!-- Modal overlay -->
	<Teleport to="body">
		<Transition
			enter-active-class="transition-opacity duration-150"
			enter-from-class="opacity-0"
			enter-to-class="opacity-100"
			leave-active-class="transition-opacity duration-150"
			leave-from-class="opacity-100"
			leave-to-class="opacity-0"
		>
			<div
				v-if="isOpen"
				class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
				@click="closeSearch"
			/>
		</Transition>

		<Transition
			enter-active-class="transition-all duration-200"
			enter-from-class="opacity-0 scale-95"
			enter-to-class="opacity-100 scale-100"
			leave-active-class="transition-all duration-150"
			leave-from-class="opacity-100 scale-100"
			leave-to-class="opacity-0 scale-95"
		>
			<div
				v-if="isOpen"
				ref="dialogRef"
				role="dialog"
				aria-modal="true"
				aria-label="Search contacts, emails, and campaigns"
				class="fixed inset-x-4 top-[15%] mx-auto max-w-xl bg-bg-elevated border border-border-default rounded-xl shadow-2xl z-50 overflow-hidden"
				@keydown="handleKeydown"
			>
				<!-- Search input -->
				<div class="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
					<Icon name="lucide:search" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
					<input
						ref="searchInputRef"
						v-model="searchQuery"
						type="text"
						placeholder="Search contacts, emails, campaigns..."
						class="flex-1 bg-transparent text-text-primary placeholder-text-tertiary outline-none text-base"
					/>
					<button
						v-if="searchQuery"
						class="p-1 text-text-tertiary hover:text-text-primary transition-colors"
						@click="searchQuery = ''"
					 aria-label="Clear search">
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
					<kbd
						class="hidden sm:inline-flex items-center px-2 py-1 text-xs text-text-tertiary bg-bg-surface border border-border-subtle rounded"
					>
						ESC
					</kbd>
				</div>

				<!-- Results area -->
				<div class="max-h-[60vh] overflow-y-auto">
					<!-- Loading state -->
					<div
						v-if="searchQuery.length >= 2 && !searchResults"
						class="px-4 py-8 text-center text-text-tertiary"
					>
						<div
							class="animate-spin w-5 h-5 border-2 border-text-tertiary border-t-brand rounded-full mx-auto"
						/>
						<p class="mt-2 text-sm">Searching...</p>
					</div>

					<!-- No results -->
					<div
						v-else-if="searchQuery.length >= 2 && !hasResults"
						class="px-4 py-8 text-center text-text-tertiary"
					>
						<Icon name="lucide:search" class="w-8 h-8 mx-auto mb-2 opacity-50" />
						<p class="text-sm">No results found for "{{ searchQuery }}"</p>
					</div>

					<!-- Results grouped by type -->
					<div v-else-if="hasResults" class="py-2">
						<!-- Contacts -->
						<div v-if="searchResults?.contacts?.length" class="mb-2">
							<div
								class="px-4 py-1.5 text-xs font-medium text-text-tertiary uppercase tracking-wider"
							>
								Contacts
							</div>
							<button
								v-for="result in searchResults.contacts"
								:key="result.id"
								:class="[
									'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
									flatResults.indexOf(result) === selectedIndex
										? 'bg-brand-subtle text-brand'
										: 'hover:bg-bg-surface text-text-primary',
								]"
								@click="navigateToResult(result.url)"
								@mouseenter="selectedIndex = flatResults.indexOf(result)"
							>
								<UiIconBox icon="lucide:users" size="sm" variant="surface" rounded="lg" />
								<div class="flex-1 min-w-0">
									<p class="text-sm font-medium truncate">{{ result.title }}</p>
									<p class="text-xs text-text-tertiary truncate">{{ result.subtitle }}</p>
								</div>
								<Icon name="lucide:arrow-right" class="w-4 h-4 text-text-tertiary flex-shrink-0" />
							</button>
						</div>

						<!-- Emails -->
						<div v-if="searchResults?.emails?.length" class="mb-2">
							<div
								class="px-4 py-1.5 text-xs font-medium text-text-tertiary uppercase tracking-wider"
							>
								Emails
							</div>
							<button
								v-for="result in searchResults.emails"
								:key="result.id"
								:class="[
									'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
									flatResults.indexOf(result) === selectedIndex
										? 'bg-brand-subtle text-brand'
										: 'hover:bg-bg-surface text-text-primary',
								]"
								@click="navigateToResult(result.url)"
								@mouseenter="selectedIndex = flatResults.indexOf(result)"
							>
								<UiIconBox icon="lucide:mail" size="sm" variant="surface" rounded="lg" />
								<div class="flex-1 min-w-0">
									<p class="text-sm font-medium truncate">{{ result.title }}</p>
									<p class="text-xs text-text-tertiary truncate">{{ result.subtitle }}</p>
								</div>
								<Icon name="lucide:arrow-right" class="w-4 h-4 text-text-tertiary flex-shrink-0" />
							</button>
						</div>

						<!-- Campaigns -->
						<div v-if="searchResults?.campaigns?.length">
							<div
								class="px-4 py-1.5 text-xs font-medium text-text-tertiary uppercase tracking-wider"
							>
								Campaigns
							</div>
							<button
								v-for="result in searchResults.campaigns"
								:key="result.id"
								:class="[
									'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
									flatResults.indexOf(result) === selectedIndex
										? 'bg-brand-subtle text-brand'
										: 'hover:bg-bg-surface text-text-primary',
								]"
								@click="navigateToResult(result.url)"
								@mouseenter="selectedIndex = flatResults.indexOf(result)"
							>
								<UiIconBox icon="lucide:megaphone" size="sm" variant="surface" rounded="lg" />
								<div class="flex-1 min-w-0">
									<p class="text-sm font-medium truncate">{{ result.title }}</p>
									<p class="text-xs text-text-tertiary truncate">{{ result.subtitle }}</p>
								</div>
								<Icon name="lucide:arrow-right" class="w-4 h-4 text-text-tertiary flex-shrink-0" />
							</button>
						</div>
					</div>

					<!-- Recent searches (when no query) -->
					<div v-else-if="searchQuery.length < 2 && recentSearches.length > 0" class="py-2">
						<div class="flex items-center justify-between px-4 py-1.5">
							<span class="text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Recent Searches
							</span>
							<button
								class="text-xs text-text-tertiary hover:text-text-primary transition-colors"
								@click="clearRecentSearches"
							>
								Clear
							</button>
						</div>
						<button
							v-for="recent in recentSearches"
							:key="recent"
							class="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-bg-surface transition-colors"
							@click="useRecentSearch(recent)"
						>
							<Icon name="lucide:clock" class="w-4 h-4 text-text-tertiary" />
							<span class="text-sm text-text-primary">{{ recent }}</span>
						</button>
					</div>

					<!-- Empty state (no query, no recent) -->
					<div v-else-if="searchQuery.length < 2" class="px-4 py-8 text-center text-text-tertiary">
						<Icon name="lucide:search" class="w-8 h-8 mx-auto mb-2 opacity-50" />
						<p class="text-sm">Start typing to search</p>
						<p class="text-xs mt-1">Search contacts, emails, and campaigns</p>
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
							>ESC</kbd
						>
						Close
					</span>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>
