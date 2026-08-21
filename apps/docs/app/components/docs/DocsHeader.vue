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
				<NuxtLink :to="localePath('/')" class="flex items-center gap-2.5 text-text-primary">
					<div
						class="w-7 h-7 text-brand"
						style="
							-webkit-mask: url('/logo.svg') no-repeat center / contain;
							mask: url('/logo.svg') no-repeat center / contain;
							background-color: currentColor;
						"
						aria-hidden="true"
					/>
					<span class="text-md font-semibold tracking-tight">{{ t('brand.docs') }}</span>
				</NuxtLink>

				<!-- Nav links (md+) -->
				<nav class="hidden md:flex items-center gap-1" :aria-label="t('nav.primary')">
					<NuxtLink
						v-for="link in navLinks"
						:key="link.to"
						:to="link.to"
						class="px-3 py-1.5 text-caption font-medium rounded-full transition-colors duration-(--motion-fast)"
						:class="
							isActiveSection(link.to)
								? 'text-text-primary'
								: 'text-text-secondary hover:text-text-primary'
						"
					>
						{{ t(link.labelKey) }}
					</NuxtLink>
				</nav>
			</div>

			<!-- Right: Search + Color mode + Mobile hamburger -->
			<div class="flex items-center gap-2">
				<!-- Search trigger -->
				<button
					class="flex items-center gap-2.5 h-9 pl-3.5 pr-2 rounded-full border border-border-default bg-transparent text-text-tertiary hover:border-border-strong hover:text-text-secondary transition-colors duration-(--motion-fast) text-caption"
					:aria-label="t('search.open')"
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
					<span class="hidden sm:inline">{{ t('search.trigger') }}</span>
					<kbd
						class="hidden sm:inline-flex items-center h-5 px-2 rounded-full border border-border-subtle bg-bg-soft text-2xs font-mono text-text-tertiary"
					>
						{{ metaKey }}K
					</kbd>
				</button>

				<!-- Language switcher -->
				<DocsLanguageSwitcher />

				<!-- Color mode toggle -->
				<UiThemeToggle
					class="flex items-center justify-center w-9 h-9 rounded-full text-text-tertiary hover:text-text-secondary hover:bg-bg-surface transition-colors duration-(--motion-fast)"
				/>

				<!-- Mobile hamburger (< lg) -->
				<button
					class="flex lg:hidden items-center justify-center w-9 h-9 rounded-full text-text-tertiary hover:text-text-secondary hover:bg-bg-surface transition-colors duration-(--motion-fast)"
					:aria-label="t('nav.toggleSidebar')"
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

const { t, locale } = useI18n();
const route = useRoute();
const localePath = useLocalePath();

const searchOpen = ref(false);

const metaKey = computed(() => {
	if (import.meta.server) return '⌘';
	return navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl+';
});

// `localePath` prefixes these with `/de` when German is active; the docs
// content path they point at is the same in both locales.
const navLinks = computed(() =>
	[
		{ labelKey: 'nav.guide', to: '/guide/getting-started' },
		{ labelKey: 'nav.api', to: '/api' },
		{ labelKey: 'nav.developer', to: '/developer' },
		{ labelKey: 'nav.vision', to: '/vision' },
	].map((link) => ({ ...link, to: localePath(link.to) }))
);

function isActiveSection(to: string): boolean {
	// `to` is already locale-prefixed, so comparing prefixes stays correct for
	// `/de/guide/…` without special-casing the locale segment.
	const segments = to.split('/').filter(Boolean);
	const section = segments[0] === locale.value ? segments.slice(0, 2) : segments.slice(0, 1);
	return route.path.startsWith(`/${section.join('/')}`);
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
