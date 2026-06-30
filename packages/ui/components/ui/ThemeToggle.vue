<script setup lang="ts">
/**
 * Theme toggle button that cycles through System -> Light -> Dark.
 *
 * Uses @nuxtjs/color-mode under the hood. The preference is persisted
 * automatically via the color-mode module's localStorage key.
 *
 * Uses inline SVGs so the component works in apps that don't have @nuxt/icon.
 */

type ThemeMode = 'system' | 'light' | 'dark';

const colorMode = useColorMode();

const current = computed<ThemeMode>(() => {
	const pref = colorMode.preference;
	if (pref === 'light' || pref === 'dark') return pref;
	return 'system';
});

const label = computed(() => {
	switch (current.value) {
		case 'light':
			return 'Light mode';
		case 'dark':
			return 'Dark mode';
		default:
			return 'System preference';
	}
});

function cycle() {
	const order: ThemeMode[] = ['system', 'light', 'dark'];
	const next = order[(order.indexOf(current.value) + 1) % order.length] as ThemeMode;
	colorMode.preference = next;
}
</script>

<template>
	<button
		:title="label"
		:aria-label="`Theme: ${label}. Click to change.`"
		@click="cycle"
	>
		<!-- lucide:monitor (System) -->
		<svg
			v-if="current === 'system'"
			class="w-[18px] h-[18px]"
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<rect width="20" height="14" x="2" y="3" rx="2" />
			<line x1="8" x2="16" y1="21" y2="21" />
			<line x1="12" x2="12" y1="17" y2="21" />
		</svg>

		<!-- lucide:sun (Light) -->
		<svg
			v-else-if="current === 'light'"
			class="w-[18px] h-[18px]"
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2" />
			<path d="M12 20v2" />
			<path d="m4.93 4.93 1.41 1.41" />
			<path d="m17.66 17.66 1.41 1.41" />
			<path d="M2 12h2" />
			<path d="M20 12h2" />
			<path d="m6.34 17.66-1.41 1.41" />
			<path d="m19.07 4.93-1.41 1.41" />
		</svg>

		<!-- lucide:moon (Dark) -->
		<svg
			v-else
			class="w-[18px] h-[18px]"
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
		</svg>

		<slot />
	</button>
</template>
