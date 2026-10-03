/**
 * The agent's draft variants (`inboundMessages.draftOptions`) as a reader may
 * see them.
 *
 * The variants belong to one agent draft: `draftOptions[0]` is that draft and
 * the rest are alternatives to it. Since #1196 every write that changes the
 * draft clears them, but a row stored before that can still carry variants of
 * a draft it no longer shows. A web build from before #1196 approves
 * `draftOptions[0]` over the shown draft whenever there are two or more, so the
 * read boundary hands out only the shown draft's variants: such a client then
 * approves the text it shows.
 *
 * Pure (no ctx, no imports).
 */

export interface DraftVariantFields {
	draftResponse?: string | null;
	draftOptions?: string[] | null;
}

/**
 * The stored variants when they are the shown draft's, else none. Compared
 * exactly, as the `draft_ready` reducer does when it decides whether a draft
 * keeps its variants.
 */
export function variantsOfShownDraft(row: DraftVariantFields): string[] {
	const options = row.draftOptions ?? [];
	return options.length > 0 && options[0] === row.draftResponse ? options : [];
}

/** A row without the variants of a draft it no longer shows. */
export function withShownDraftVariants<T extends DraftVariantFields>(row: T): T {
	if (row.draftOptions == null || variantsOfShownDraft(row).length > 0) return row;
	const { draftOptions: _stale, ...rest } = row;
	return rest as T;
}

/**
 * Whether `text` is one of the stored variants, ignoring surrounding
 * whitespace: the old card trimmed a variant before writing it as the draft.
 */
export function isStoredVariant(row: DraftVariantFields, text: string): boolean {
	const saved = text.trim();
	return (row.draftOptions ?? []).some((option) => option.trim() === saved);
}
