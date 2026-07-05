<template>
	<header
		class="sticky top-0 z-40 border-b border-border-subtle pt-[env(safe-area-inset-top)]"
		style="
			background-color: color-mix(in oklab, var(--color-bg-base) 85%, transparent);
			backdrop-filter: saturate(160%) blur(16px);
			-webkit-backdrop-filter: saturate(160%) blur(16px);
		"
	>
		<div
			class="max-w-[1400px] w-full mx-auto h-[60px] flex items-center justify-between px-6 max-md:px-4"
		>
			<!-- Left: Logo -->
			<div class="flex items-center gap-6">
				<NuxtLink to="/" class="flex items-center gap-2.5 text-text-primary">
					<div
						class="w-7 h-7 text-brand"
						style="
							-webkit-mask: url('/logo.svg') no-repeat center / contain;
							mask: url('/logo.svg') no-repeat center / contain;
							background-color: currentColor;
						"
						aria-hidden="true"
					/>
					<span class="text-[0.9375rem] font-semibold tracking-tight">Owlat Docs</span>
				</NuxtLink>

				<!-- Nav links (md+) -->
				<nav class="hidden md:flex items-center gap-6">
					<NuxtLink
						v-for="link in navLinks"
						:key="link.to"
						:to="link.to"
						class="text-[0.8125rem] font-medium py-1 transition-colors duration-(--motion-fast)"
						:class="
							isActiveSection(link.to)
								? 'text-text-primary'
								: 'text-text-secondary hover:text-text-primary'
						"
					>
						{{ link.label }}
					</NuxtLink>
				</nav>
			</div>

			<!-- Right: Search + Color mode + Mobile hamburger -->
			<div class="flex items-center gap-2">
				<!-- Search trigger -->
				<button
					class="flex items-center gap-2.5 h-9 pl-3 pr-2.5 rounded-lg border border-border-subtle bg-bg-surface text-text-tertiary hover:text-text-secondary transition-colors duration-(--motion-fast) text-sm"
					@click="searchOpen = true"
				>
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
						/>
					</svg>
					<span class="hidden sm:inline">Search...</span>
					<kbd
						class="hidden sm:inline-flex items-center h-5 px-1.5 rounded border border-border-subtle bg-bg-elevated text-[11px] font-mono text-text-tertiary"
					>
						{{ metaKey }}K
					</kbd>
				</button>

				<!-- Color mode toggle -->
				<UiThemeToggle
					class="flex items-center justify-center w-9 h-9 rounded-lg text-text-tertiary hover:text-text-secondary hover:bg-bg-surface transition-colors duration-(--motion-fast)"
				/>

				<!-- Mobile hamburger (< lg) -->
				<button
					class="flex lg:hidden items-center justify-center w-9 h-9 rounded-lg text-text-tertiary hover:text-text-secondary hover:bg-bg-surface transition-colors duration-(--motion-fast)"
					aria-label="Toggle sidebar"
					@click="$emit('toggleSidebar')"
				>
					<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M4 6h16M4 12h16M4 18h16"
						/>
					</svg>
				</button>
			</div>
		</div>

		<DocsSearch v-model:open="searchOpen" />
	</header>
</template>

<script setup lang="ts">
defineEmits<{
	toggleSidebar: [];
}>();

const route = useRoute();

const searchOpen = ref(false);

const metaKey = computed(() => {
	if (import.meta.server) return '⌘';
	return navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl+';
});

const navLinks = [
	{ label: 'Guide', to: '/guide/getting-started' },
	{ label: 'API', to: '/api' },
	{ label: 'Developer', to: '/developer' },
	{ label: 'Vision', to: '/vision' },
];

function isActiveSection(to: string): boolean {
	const section = to.split('/')[1];
	return route.path.startsWith(`/${section}`);
}

function onKeydown(e: KeyboardEvent) {
	if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
		e.preventDefault();
		searchOpen.value = true;
	}
}

onMounted(() => {
	window.addEventListener('keydown', onKeydown);

	onUnmounted(() => {
		window.removeEventListener('keydown', onKeydown);
	});
});
</script>
