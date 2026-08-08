/**
 * App theme composable for managing dark/light mode.
 * Thin wrapper around @nuxtjs/color-mode.
 *
 * Theme options:
 * - 'dark': Always use dark mode
 * - 'light': Always use light mode
 * - 'system': Follow system preference
 */

export type ThemeOption = 'dark' | 'light' | 'system';

export function useAppTheme() {
	const colorMode = useColorMode();

	const themePreference = computed<ThemeOption>(() => {
		const pref = colorMode.preference;
		if (pref === 'light' || pref === 'dark' || pref === 'system') return pref;
		return 'system';
	});

	const resolvedTheme = computed<'dark' | 'light'>(() => {
		// Light-first: anything that isn't explicitly dark resolves light,
		// matching the color-mode fallback in nuxt.config.
		const value = colorMode.value;
		return value === 'dark' ? 'dark' : 'light';
	});

	const isDark = computed(() => resolvedTheme.value === 'dark');
	const isLight = computed(() => resolvedTheme.value === 'light');

	// Always true — @nuxtjs/color-mode handles SSR via cookies
	const isHydrated = computed(() => true);

	const setTheme = (theme: ThemeOption) => {
		colorMode.preference = theme;
	};

	return {
		themePreference,
		resolvedTheme,
		isDark,
		isLight,
		isHydrated,
		setTheme,
	};
}
