<template>
	<header
		ref="headerEl"
		class="sticky top-0 z-40 pt-[env(safe-area-inset-top)] transition-[background-color,border-color,box-shadow] duration-(--motion-moderate)"
		:class="scrolled ? 'border-b border-border-default' : 'border-b border-transparent'"
		:style="
			scrolled
				? {
						backdropFilter: 'saturate(160%) blur(16px)',
						WebkitBackdropFilter: 'saturate(160%) blur(16px)',
						backgroundColor: 'color-mix(in oklab, var(--color-bg-base) 80%, transparent)',
					}
				: { backgroundColor: 'var(--color-bg-base)' }
		"
	>
		<div
			class="max-w-[1400px] w-full mx-auto h-[60px] flex items-center justify-between px-6 max-md:px-4"
		>
			<!-- Left: Logo -->
			<div class="flex items-center gap-6">
				<NuxtLink to="/" class="flex items-center gap-2.5 text-text-primary group">
					<div
						class="w-7 h-7 text-brand transition-[color,transform] duration-(--motion-moderate) group-hover:text-brand-hover group-hover:scale-110"
						style="
							-webkit-mask: url('/logo.svg') no-repeat center / contain;
							mask: url('/logo.svg') no-repeat center / contain;
							background-color: currentColor;
						"
						aria-hidden="true"
					/>
					<span
						class="font-display text-xl tracking-tight transition-colors duration-(--motion-fast) group-hover:text-brand"
						>Owlat Docs</span
					>
				</NuxtLink>

				<!-- Nav links (md+) -->
				<nav class="hidden md:flex items-center gap-1">
					<NuxtLink
						v-for="link in navLinks"
						:key="link.to"
						:to="link.to"
						class="nav-link px-3 py-1.5 text-sm rounded-lg transition-all duration-(--motion-moderate)"
						:class="
							isActiveSection(link.to)
								? 'text-brand bg-brand-soft'
								: 'text-text-secondary hover:text-text-primary hover:bg-bg-surface'
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
					class="search-trigger flex items-center gap-2.5 h-9 pl-3 pr-2.5 rounded-lg border border-border-default bg-bg-surface text-text-tertiary hover:text-text-secondary hover:border-border-strong transition-all duration-(--motion-moderate) text-sm"
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
						class="hidden sm:inline-flex items-center h-5 px-1.5 rounded border border-border-default bg-bg-elevated text-[11px] font-mono text-text-tertiary"
					>
						{{ metaKey }}K
					</kbd>
				</button>

				<!-- Color mode toggle -->
				<UiThemeToggle
					class="color-toggle flex items-center justify-center w-9 h-9 rounded-lg text-text-tertiary hover:text-text-secondary hover:bg-bg-surface transition-all duration-(--motion-moderate)"
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

const scrolled = ref(false);
const searchOpen = ref(false);
const headerEl = ref<HTMLElement | null>(null);

const metaKey = computed(() => {
	if (import.meta.server) return '\u2318';
	return navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl+';
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
	const onScroll = () => {
		scrolled.value = window.scrollY > 4;
	};
	window.addEventListener('scroll', onScroll, { passive: true });
	window.addEventListener('keydown', onKeydown);

	onUnmounted(() => {
		window.removeEventListener('scroll', onScroll);
		window.removeEventListener('keydown', onKeydown);
	});
});
</script>

<style scoped>
/* Search trigger hover: one elevation ring, no glow */
.search-trigger:hover {
	box-shadow: var(--shadow-1);
}

/* Color toggle rotation */
.color-toggle:active svg {
	transition: transform var(--motion-moderate) var(--ease-spring);
	transform: rotate(25deg) scale(0.9);
}

/* Nav link active dot indicator */
.nav-link {
	position: relative;
}
</style>
