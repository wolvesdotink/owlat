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
		const value = colorMode.value;
		return value === 'light' ? 'light' : 'dark';
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
