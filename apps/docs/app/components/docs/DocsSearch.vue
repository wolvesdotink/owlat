<template>
	<Teleport to="body">
		<Transition name="search-modal">
			<div
				v-if="open"
				class="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]"
				@keydown.escape="emit('update:open', false)"
			>
				<!-- Backdrop -->
				<div
					class="absolute inset-0 bg-black/60 backdrop-blur-sm"
					@click="emit('update:open', false)"
				/>

				<!-- Modal -->
				<div
					class="search-modal-inner relative w-full max-w-lg mx-4 bg-bg-elevated border border-border-default rounded-2xl shadow-lg overflow-hidden"
				>
					<!-- Search input -->
					<div class="flex items-center gap-3 px-4 h-14 border-b border-border-subtle">
						<svg
							class="w-5 h-5 text-text-tertiary shrink-0"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
							/>
						</svg>
						<input
							ref="inputEl"
							v-model="search"
							type="text"
							placeholder="Search documentation..."
							class="flex-1 bg-transparent text-text-primary placeholder-text-tertiary outline-none text-sm"
							@keydown.down.prevent="moveSelection(1)"
							@keydown.up.prevent="moveSelection(-1)"
							@keydown.enter.prevent="selectCurrent"
						/>
						<kbd
							class="hidden sm:inline-flex items-center h-5 px-1.5 rounded border border-border-default bg-bg-surface text-[11px] font-mono text-text-tertiary"
						>
							ESC
						</kbd>
					</div>

					<!-- Results -->
					<div class="max-h-[50vh] overflow-y-auto py-2">
						<!-- Loading -->
						<div
							v-if="status === 'pending' && search.length > 0"
							class="px-4 py-8 text-center text-text-tertiary text-sm"
						>
							<div class="search-loading-dots"><span /><span /><span /></div>
						</div>

						<!-- Empty state -->
						<div
							v-else-if="search.length > 0 && flatResults.length === 0"
							class="px-4 py-8 text-center text-text-tertiary text-sm"
						>
							No results found for "{{ search }}"
						</div>

						<!-- Results list -->
						<template v-else-if="search.length > 0 && flatResults.length > 0">
							<div
								v-for="(result, index) in flatResults"
								:key="result.path"
								class="search-result"
								:style="{ '--result-i': index }"
							>
								<button
									class="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-all duration-(--motion-moderate)"
									:class="
										selectedIndex === index
											? 'bg-brand-soft text-text-primary'
											: 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'
									"
									@click="navigateTo(result.path)"
									@mouseenter="selectedIndex = index"
								>
									<svg
										class="w-4 h-4 shrink-0 text-text-tertiary"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
										/>
									</svg>
									<div class="min-w-0 flex-1">
										<div class="text-sm font-medium truncate">
											{{ result.title }}
										</div>
										<div
											v-if="result.description"
											class="text-xs text-text-tertiary truncate mt-0.5"
										>
											{{ result.description }}
										</div>
									</div>
									<span class="text-[11px] text-text-tertiary capitalize shrink-0">
										{{ getSectionLabel(result.path) }}
									</span>
								</button>
							</div>
						</template>

						<!-- Empty input state -->
						<div v-else class="px-4 py-8 text-center text-text-tertiary text-sm">
							Type to search the documentation
						</div>
					</div>

					<!-- Footer -->
					<div
						class="flex items-center justify-between px-4 h-10 border-t border-border-subtle text-[11px] text-text-tertiary"
					>
						<div class="flex items-center gap-3">
							<span class="flex items-center gap-1">
								<kbd
									class="inline-flex items-center justify-center w-4 h-4 rounded border border-border-default bg-bg-surface font-mono"
									>&uarr;</kbd
								>
								<kbd
									class="inline-flex items-center justify-center w-4 h-4 rounded border border-border-default bg-bg-surface font-mono"
									>&darr;</kbd
								>
								Navigate
							</span>
							<span class="flex items-center gap-1">
								<kbd
									class="inline-flex items-center justify-center h-4 px-1 rounded border border-border-default bg-bg-surface font-mono"
									>&crarr;</kbd
								>
								Select
							</span>
						</div>
					</div>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>

<script setup lang="ts">
interface SearchResult {
	path: string;
	title: string;
	description?: string;
}

const props = defineProps<{
	open: boolean;
}>();

const emit = defineEmits<{
	'update:open': [value: boolean];
}>();

const router = useRouter();
const search = ref('');
const selectedIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);

const { data: results, status } = await useAsyncData(
	'search',
	() =>
		queryCollection('content')
			.where('title', 'LIKE', `%${search.value}%`)
			.select('path', 'title', 'description')
			.all(),
	{ watch: [search], default: () => [] }
);

const flatResults = computed<SearchResult[]>(() => {
	if (!results.value) return [];
	return results.value as unknown as SearchResult[];
});

function getSectionLabel(path: string): string {
	const segment = path.split('/')[1];
	return segment || 'docs';
}

function moveSelection(delta: number) {
	const len = flatResults.value.length;
	if (len === 0) return;
	selectedIndex.value = (selectedIndex.value + delta + len) % len;
}

function selectCurrent() {
	const result = flatResults.value[selectedIndex.value];
	if (result) {
		navigateTo(result.path);
	}
}

function navigateTo(path: string) {
	emit('update:open', false);
	router.push(path);
}

// Focus input on open
watch(
	() => props.open,
	async (isOpen) => {
		if (isOpen) {
			search.value = '';
			selectedIndex.value = 0;
			await nextTick();
			inputEl.value?.focus();
		}
	}
);

// Reset selection on search change
watch(search, () => {
	selectedIndex.value = 0;
});

// Lock body scroll when open
watch(
	() => props.open,
	(isOpen) => {
		if (import.meta.server) return;
		document.body.style.overflow = isOpen ? 'hidden' : '';
	}
);
</script>

<style scoped>
/* Modal transitions — slow tier dialog: bouncy spring in, quick tween out */
.search-modal-enter-active {
	transition: opacity var(--motion-slow) var(--ease-spring);
}

.search-modal-leave-active {
	transition: opacity var(--motion-slow-exit) var(--ease-exit);
}

.search-modal-enter-active .search-modal-inner {
	transition:
		transform var(--motion-slow) var(--ease-spring-bounce),
		opacity var(--motion-slow) var(--ease-spring);
}

.search-modal-leave-active .search-modal-inner {
	transition:
		transform var(--motion-slow-exit) var(--ease-exit),
		opacity var(--motion-slow-exit) var(--ease-exit);
}

.search-modal-enter-from,
.search-modal-leave-to {
	opacity: 0;
}

.search-modal-enter-from .search-modal-inner {
	transform: scale(0.95) translateY(-12px);
	opacity: 0;
}

.search-modal-leave-to .search-modal-inner {
	transform: scale(0.97) translateY(6px);
	opacity: 0;
}

/* Stagger search results */
.search-result {
	animation: result-in var(--motion-moderate) var(--ease-spring) both;
	animation-delay: calc(var(--result-i, 0) * 0.03s);
}

@keyframes result-in {
	from {
		opacity: 0;
		transform: translateY(6px);
	}
	to {
		opacity: 1;
		transform: translateY(0);
	}
}

/* Loading dots */
.search-loading-dots {
	display: flex;
	justify-content: center;
	gap: 6px;
}

.search-loading-dots span {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: var(--color-text-tertiary);
	animation: loading-pulse 1.2s ease-in-out infinite;
}

.search-loading-dots span:nth-child(2) {
	animation-delay: 0.15s;
}

.search-loading-dots span:nth-child(3) {
	animation-delay: 0.3s;
}

@keyframes loading-pulse {
	0%,
	80%,
	100% {
		opacity: 0.3;
		transform: scale(0.8);
	}
	40% {
		opacity: 1;
		transform: scale(1);
	}
}
</style>
