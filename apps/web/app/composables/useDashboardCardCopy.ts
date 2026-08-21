/**
 * THE RENDER BOUNDARY FOR THE DASHBOARD CARD CATALOG.
 *
 * The card catalog lives in the backend (`DEFAULT_CARDS` in
 * `apps/api/convex/analytics/adaptiveDashboard.ts`, served by
 * `getAvailableCards`), and it keeps its English `label`/`description`: the
 * query is a Convex read model shared with non-browser callers, and the widget
 * registry is built to grow bundled-plugin cards whose names no shipped catalog
 * can contain. The web still has to paint German, so the words come from
 * `sharedPkg.adaptiveDashboard.cards.<type>.*` — a key DERIVED from the card
 * type, the same trick `useFeatureCopy()` uses for the shared flag registry.
 *
 * The fallback is the point: a card type the catalog does not know (a plugin
 * card, or one added to the backend catalog before its messages land) renders
 * the backend's own English instead of the key path a bare `t()` would have
 * painted at the operator.
 */

/** Catalog key for a card's name, derived from the card type. */
export function dashboardCardLabelKey(type: string): string {
	return `sharedPkg.adaptiveDashboard.cards.${type}.label`;
}

export function dashboardCardDescriptionKey(type: string): string {
	return `sharedPkg.adaptiveDashboard.cards.${type}.description`;
}

/** The shape `getAvailableCards` returns — the catalog entry a card is named by. */
export interface DashboardCardCopySource {
	type: string;
	label: string;
	description: string;
}

export function useDashboardCardCopy() {
	const { t, te } = useI18n();

	/** The catalog's words when it has them, the backend's English when it does not. */
	const translated = (key: string, fallback: string): string => (te(key) ? t(key) : fallback);

	return {
		cardLabel: (card: DashboardCardCopySource): string =>
			translated(dashboardCardLabelKey(card.type), card.label),
		cardDescription: (card: DashboardCardCopySource): string =>
			translated(dashboardCardDescriptionKey(card.type), card.description),
	};
}
