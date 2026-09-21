/**
 * Files-view facet vocabulary and the pure state transitions behind it.
 *
 * Lives here rather than in the panel so the facet rules test without mounting
 * a Convex-backed component: which kinds exist, what a date preset means in
 * milliseconds, and how a click on a facet chip changes the selection.
 *
 * Every label is a {key, params} pair resolved by the caller's `t()` at the
 * render boundary — the registry itself never holds display prose.
 */

/** The coarse type facet, matching `mail/attachmentIndex.attachmentKind`. */
export type PostboxFileKind = 'pdf' | 'image' | 'document' | 'archive' | 'other';

export interface PostboxFacetOption<T extends string> {
	value: T;
	labelKey: string;
}

/**
 * The type facet's chips, in display order. `pdf` and `image` lead because
 * "the contract" and "the screenshot" are the two things people come here for;
 * `other` is last because it is the residue, not a category.
 */
export const POSTBOX_FILE_KINDS: readonly PostboxFacetOption<PostboxFileKind>[] = [
	{ value: 'pdf', labelKey: 'components.postbox.postboxFilesPanel.kinds.pdf' },
	{ value: 'image', labelKey: 'components.postbox.postboxFilesPanel.kinds.image' },
	{ value: 'document', labelKey: 'components.postbox.postboxFilesPanel.kinds.document' },
	{ value: 'archive', labelKey: 'components.postbox.postboxFilesPanel.kinds.archive' },
	{ value: 'other', labelKey: 'components.postbox.postboxFilesPanel.kinds.other' },
];

/** The date facet's presets. `all` is the absence of a bound, not a range. */
export type PostboxFileDateRange = 'all' | 'week' | 'month' | 'year';

export const POSTBOX_FILE_DATE_RANGES: readonly PostboxFacetOption<PostboxFileDateRange>[] = [
	{ value: 'all', labelKey: 'components.postbox.postboxFilesPanel.dates.all' },
	{ value: 'week', labelKey: 'components.postbox.postboxFilesPanel.dates.week' },
	{ value: 'month', labelKey: 'components.postbox.postboxFilesPanel.dates.month' },
	{ value: 'year', labelKey: 'components.postbox.postboxFilesPanel.dates.year' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The `afterMs` bound a date preset stands for, or undefined for "all time".
 *
 * A rolling window from `now` rather than a calendar boundary: "this month" on
 * the 1st would hide everything, which is the wrong answer to "recent files".
 */
export function fileDateAfterMs(range: PostboxFileDateRange, now: number): number | undefined {
	switch (range) {
		case 'week':
			return now - 7 * DAY_MS;
		case 'month':
			return now - 30 * DAY_MS;
		case 'year':
			return now - 365 * DAY_MS;
		default:
			return undefined;
	}
}

/**
 * Toggle one kind in the selection.
 *
 * An EMPTY selection means "every kind" — the same thing selecting all five
 * would mean, spelled the way the query wants it. So un-ticking the last kind
 * lands back on "All" instead of on an empty result set nobody asked for.
 */
export function toggleFileKind(
	selected: readonly PostboxFileKind[],
	kind: PostboxFileKind
): PostboxFileKind[] {
	return selected.includes(kind)
		? selected.filter((k) => k !== kind)
		: [...selected, kind].sort(
				(a, b) =>
					POSTBOX_FILE_KINDS.findIndex((o) => o.value === a) -
					POSTBOX_FILE_KINDS.findIndex((o) => o.value === b)
			);
}

/** Is any facet narrowing the list? Drives the "Clear filters" affordance. */
export function hasActiveFileFacets(state: {
	kinds: readonly PostboxFileKind[];
	dateRange: PostboxFileDateRange;
	fromAddress: string | null;
	query: string;
}): boolean {
	return (
		state.kinds.length > 0 ||
		state.dateRange !== 'all' ||
		state.fromAddress !== null ||
		state.query.trim() !== ''
	);
}

/**
 * Only image and PDF parts can be shown in the Quick Look overlay; everything
 * else downloads. Same rule the thread reader applies, kept in one place so the
 * two views can never disagree about what "previewable" means.
 */
export function isPreviewableFile(contentType: string): boolean {
	const type = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
	return type.startsWith('image/') || type === 'application/pdf';
}

/**
 * The lightbox's slice of a listing: the previewable files, and where the
 * clicked one sits among them.
 *
 * Returns null when the clicked file is not previewable, so the caller falls
 * through to a download instead of opening an overlay onto an error state.
 */
export function previewSliceFor<T extends { contentType: string }>(
	files: readonly T[],
	clicked: T
): { attachments: T[]; index: number } | null {
	const previewable = files.filter((f) => isPreviewableFile(f.contentType));
	const index = previewable.indexOf(clicked);
	return index === -1 ? null : { attachments: previewable, index };
}
