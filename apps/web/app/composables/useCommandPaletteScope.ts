/**
 * The overlay's active scope: seeded from the route, changed by Tab, `?` and
 * the ⌘⇧K alias.
 *
 * Split out of `AppCommandPalette.vue` so the component keeps only the state it
 * renders. The route→scope table and the cycle rule are pure
 * (`~/lib/commandPaletteScope`); this adds the route read, the `ai.knowledge`
 * gate on the Ask scope, and the `?`-prefix override.
 */
import {
	type PaletteScope,
	defaultScopeForRoute,
	nextPaletteScope,
} from '~/lib/commandPaletteScope';
import type { PaletteMode } from '~/lib/commandPalette';

/** What the overlay is doing with what you type right now. */
export type PalettePrompt = 'ask' | 'mailSearch' | 'palette';

export function useCommandPaletteScope(mode: () => PaletteMode) {
	const route = useRoute();
	const { isEnabled: isFlagEnabled } = useFeatureFlag();

	/** Knowledge answers are flag-gated, so the Ask scope can be absent entirely. */
	const isAskAvailable = computed(() => isFlagEnabled('ai.knowledge'));

	const scope = ref<PaletteScope>('everything');

	/** The scope this route opens in — the palette resets to it on every open. */
	function routeScope(): PaletteScope {
		const preferred = defaultScopeForRoute(route.path);
		return preferred === 'ask' && !isAskAvailable.value ? 'everything' : preferred;
	}

	/** Open in `preferred` when the caller named one, otherwise follow the route. */
	function resetScope(preferred?: PaletteScope) {
		if (preferred && (preferred !== 'ask' || isAskAvailable.value)) {
			scope.value = preferred;
			return;
		}
		scope.value = routeScope();
	}

	/** Tab. Skips a scope the instance switched off; never a dead key. */
	function cycleScope() {
		scope.value = nextPaletteScope(
			scope.value,
			(candidate) => candidate !== 'ask' || isAskAvailable.value
		);
	}

	/**
	 * A typed `?` asks knowledge from any scope, so it wins over the chip. With
	 * knowledge disabled the prefix is inert and the query reads as plain text.
	 */
	const isAsking = computed(
		() => isAskAvailable.value && (mode() === 'ask' || (scope.value === 'ask' && mode() === 'all'))
	);

	const prompt = computed<PalettePrompt>(() => {
		if (isAsking.value) return 'ask';
		if (scope.value === 'mail' && mode() === 'all') return 'mailSearch';
		return 'palette';
	});

	/**
	 * The mode the group filter sees. `ask` narrows to groups no provider
	 * declares, which would blank the palette on a `?` typed while knowledge is
	 * off — so with the flag down the prefix degrades to a plain query.
	 */
	const effectiveMode = computed<PaletteMode>(() => {
		const current = mode();
		return current === 'ask' && !isAskAvailable.value ? 'all' : current;
	});

	return { scope, prompt, effectiveMode, isAskAvailable, resetScope, cycleScope };
}
