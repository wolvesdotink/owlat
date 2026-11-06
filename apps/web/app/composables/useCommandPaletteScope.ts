/**
 * The overlay's active scope: seeded from the route, changed by Tab, `?` and
 * the ⌘⇧K alias.
 *
 * Split out of `AppCommandPalette.vue` so the component keeps only the state it
 * renders. The route→scope table and the cycle rule are pure
 * (`~/lib/commandPaletteScope`); this adds the route read, the `ai.knowledge`
 * gate on the Ask scope, and the `?`-prefix override, which in Mail scope asks
 * the person's mail instead (gated on `ai`).
 */
import {
	type PaletteScope,
	defaultScopeForRoute,
	nextPaletteScope,
} from '~/lib/commandPaletteScope';
import type { PaletteMode } from '~/lib/commandPalette';
import { type MaybeRefOrGetter, toValue } from 'vue';

/**
 * What the overlay is doing with what you type right now. `argument` is an open
 * submenu: the box only filters that item's options, whatever the scope chip
 * said before it opened, so no scope's Enter or backend applies to it.
 */
export type PalettePrompt = 'argument' | 'ask' | 'mailAsk' | 'mailSearch' | 'palette';

/**
 * @param mode The typed prefix's mode.
 * @param submenu The open submenu, if any (anything truthy means one is open).
 */
export function useCommandPaletteScope(
	mode: () => PaletteMode,
	submenu: MaybeRefOrGetter<unknown>
) {
	const route = useRoute();
	const { isEnabled: isFlagEnabled } = useFeatureFlag();

	/** Knowledge answers are flag-gated, so the Ask scope can be absent entirely. */
	const isAskAvailable = computed(() => isFlagEnabled('ai.knowledge'));
	/** Answers from mail need Postbox AI, which knowledge does not imply. */
	const isMailAskAvailable = computed(() => isFlagEnabled('ai'));

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
	 * A typed `?` asks knowledge from any scope but Mail, so it wins over the
	 * chip. With knowledge disabled the prefix is inert and the query reads as
	 * plain text.
	 */
	const isAsking = computed(
		() => isAskAvailable.value && (mode() === 'ask' || (scope.value === 'ask' && mode() === 'all'))
	);

	/** A `?` typed in Mail scope asks the person's mail, not the knowledge base. */
	const isMailAsking = computed(
		() => isMailAskAvailable.value && scope.value === 'mail' && mode() === 'ask'
	);

	const prompt = computed<PalettePrompt>(() => {
		if (toValue(submenu)) return 'argument';
		if (isMailAsking.value) return 'mailAsk';
		if (isAsking.value) return 'ask';
		if (scope.value === 'mail' && mode() === 'all') return 'mailSearch';
		return 'palette';
	});

	/** The box's placeholder, as a message key: what typing does right now. */
	const placeholderKey = computed(() => {
		if (prompt.value === 'argument') return 'components.appCommandPalette.filterPlaceholder';
		if (prompt.value === 'ask') return 'components.query.quickQueryPanel.placeholder';
		if (prompt.value === 'mailAsk') return 'components.appCommandPalette.mailAsk.placeholder';
		if (scope.value === 'mail') return 'components.postbox.postboxSearchBar.placeholder';
		return 'components.appCommandPalette.searchPlaceholder';
	});

	/**
	 * The mode the group filter sees. `ask` narrows to groups no provider
	 * declares, which would blank the palette on a `?` typed while knowledge is
	 * off — so with the flag down the prefix degrades to a plain query.
	 */
	const effectiveMode = computed<PaletteMode>(() => {
		const current = mode();
		return current === 'ask' && !isAskAvailable.value && !isMailAsking.value ? 'all' : current;
	});

	return {
		scope,
		prompt,
		effectiveMode,
		isAskAvailable,
		isMailAskAvailable,
		placeholderKey,
		resetScope,
		cycleScope,
	};
}
