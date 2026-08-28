/**
 * The account export's pre-run manifest and its progress bar (idea 67).
 *
 * "Export my data" used to be a button and a spinner. For a mailbox with years
 * of mail that spinner runs for minutes with nothing to distinguish it from a
 * hang, and nothing anywhere said what the file was going to contain. This
 * module holds both halves of the fix, pure:
 *
 *  - {@link buildAccountExportManifest} turns the backend's plan into the list
 *    the card shows BEFORE the run: every resource by name, with a row count
 *    where one is knowable;
 *  - {@link accountExportPercent} turns rows-written-so-far into a bar, and is
 *    deliberately honest about the two ways it can be wrong.
 *
 * Labels are catalog KEYS. Module scope never calls `useI18n`; the card resolves
 * them at the render boundary.
 */

/** What the backend can say about one resource before the export runs. */
export interface AccountExportPlanEntry {
	resource: string;
	count: number;
	/** The count stopped at the backend's cap; the real number is higher. */
	isCapped: boolean;
}

/** One line of the manifest. */
export interface AccountExportManifestRow {
	resource: string;
	labelKey: string;
	/** `null` when the row is included but was not counted in advance. */
	count: number | null;
	isCapped: boolean;
}

const RESOURCE_LABEL_PREFIX = 'shared.accountExportResources.';

/**
 * Catalog key for a resource name. Derived rather than a hand-written map: the
 * resource vocabulary is `@owlat/shared`'s, and a map here would silently miss
 * whatever is added there — a manifest that omits a resource is exactly the
 * kind of quiet incompleteness this card exists to end.
 */
export function accountExportResourceLabelKey(resource: string): string {
	return `${RESOURCE_LABEL_PREFIX}${resource}`;
}

/**
 * The manifest rows, personal resources first (the ones a person recognises as
 * "my mail"), then the organization resources the export also contains.
 *
 * Organization rows carry `count: null`: counting them means re-walking exactly
 * the rows the export is about to stream, so they are counted AS they stream
 * instead of being guessed at here.
 */
export function buildAccountExportManifest(plan: {
	personal: AccountExportPlanEntry[];
	organizationResources: string[];
}): AccountExportManifestRow[] {
	return [
		...plan.personal.map((entry) => ({
			resource: entry.resource,
			labelKey: accountExportResourceLabelKey(entry.resource),
			count: entry.count,
			isCapped: entry.isCapped,
		})),
		...plan.organizationResources.map((resource) => ({
			resource,
			labelKey: accountExportResourceLabelKey(resource),
			count: null,
			isCapped: false,
		})),
	];
}

/** Rows the manifest expects, i.e. the progress bar's denominator. */
export function plannedRowTotal(rows: AccountExportManifestRow[]): number {
	return rows.reduce((total, row) => total + (row.count ?? 0), 0);
}

/**
 * Percent complete, or `null` when the bar should render indeterminate.
 *
 * Two honest limits are baked in. There is no denominator at all until the plan
 * has loaded, so an export started before it lands shows a moving spinner rather
 * than a fake 0%. And the denominator counts only the resources that WERE
 * counted in advance, so a run always finishes with more rows written than
 * planned — the bar therefore never reads 100% while work remains, capping at 99
 * until the caller reports completion.
 */
export function accountExportPercent(state: {
	rowsWritten: number;
	plannedRows: number;
	isComplete?: boolean;
}): number | null {
	if (state.isComplete) return 100;
	if (state.plannedRows <= 0) return null;
	const ratio = (state.rowsWritten / state.plannedRows) * 100;
	return Math.max(0, Math.min(99, Math.round(ratio)));
}
