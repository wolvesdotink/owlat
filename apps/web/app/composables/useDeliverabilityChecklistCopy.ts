/**
 * THE RENDER BOUNDARY FOR THE SHARED DELIVERABILITY CHECKLIST TAXONOMY.
 *
 * `@owlat/shared/deliverabilityChecklist` keeps its `title`/`impact` as English
 * sentences rather than catalog keys, because the words leave the browser: the
 * copyable diagnostic report prints `Check: <title>` beside the raw status codes
 * (`deliverabilityDiagnostics.ts`), and a regression alert is STORED and MAILED
 * as `"<title> regressed after a confirmed pass: …"` from Convex, where no
 * vue-i18n instance exists and the reader may not be the operator who set the
 * locale. The group label and description arrive the same way — the Center read
 * model (`apps/api/convex/delivery/checklist.ts`) builds them per severity.
 *
 * The web still has to paint German, so the copy comes from
 * `sharedPkg.deliverabilityChecklist.*` — a key DERIVED from the check id and
 * the group's severity, the same trick `useFeatureCopy()` uses for the shared
 * feature-flag registry. The fallback is the point: a check id or group key this
 * bundle's catalog does not know (an older browser tab against a newer server)
 * renders the payload's own English instead of the key path a bare `t()` would
 * have painted at the operator.
 *
 * `apps/web/app/__tests__/sharedRegistryCatalog.test.ts` pins the two copies of
 * the English together, so editing a sentence in the registry without editing
 * the catalog fails.
 */

/** Catalog key for a check's name. Dots in the check id nest, as they do in JSON. */
export function checklistItemTitleKey(itemId: string): string {
	return `sharedPkg.deliverabilityChecklist.items.${itemId}.title`;
}

export function checklistItemImpactKey(itemId: string): string {
	return `sharedPkg.deliverabilityChecklist.items.${itemId}.impact`;
}

export function checklistGroupLabelKey(groupKey: string): string {
	return `sharedPkg.deliverabilityChecklist.groups.${groupKey}.label`;
}

export function checklistGroupDescriptionKey(groupKey: string): string {
	return `sharedPkg.deliverabilityChecklist.groups.${groupKey}.description`;
}

export function useDeliverabilityChecklistCopy() {
	const { t, te } = useI18n();

	/** The catalog's words when it has them, the payload's English when it does not. */
	const translated = (key: string, fallback: string): string => (te(key) ? t(key) : fallback);

	return {
		/** A check's name — the row heading, the toast, the alert's check name. */
		itemTitle: (item: { id: string; title: string }): string =>
			translated(checklistItemTitleKey(item.id), item.title),
		/** Why the check matters, shown once a row is expanded. */
		itemImpact: (item: { id: string; impact: string }): string =>
			translated(checklistItemImpactKey(item.id), item.impact),
		/** A check's name from its id alone — for an alert whose check is gone. */
		itemIdTitle: (itemId: string, fallback: string): string =>
			translated(checklistItemTitleKey(itemId), fallback),
		groupLabel: (group: { key: string; label: string }): string =>
			translated(checklistGroupLabelKey(group.key), group.label),
		groupDescription: (group: { key: string; description: string }): string =>
			translated(checklistGroupDescriptionKey(group.key), group.description),
	};
}
