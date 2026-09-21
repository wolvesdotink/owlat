/**
 * Split-inbox sections (idea 24) — the pure half.
 *
 * A section is named by a `pinToSection` filter action; the server returns the
 * sections in filter run order with the unnamed remainder ("Everything else")
 * last. Everything here is framework-free so the paging arithmetic — which is
 * the only part with a real invariant — tests without mounting the list.
 *
 * PAGING. The server pages each section on its OWN limit (see
 * apps/api/convex/mail/sections.ts for why), so the client's whole paging state
 * is one number per section. "Load more" grows exactly the section the user
 * clicked and leaves every other section's page untouched — which is what stops
 * a chatty section from starving a quiet one.
 */

/**
 * Wire key for the unnamed remainder. The server addresses "Everything else" by
 * the empty string because `null` is not expressible in the limits array; this
 * constant is the one place that mapping lives.
 */
export const POSTBOX_SECTION_OTHER_KEY = '';

/** Rows the client asks for per section on first render (mirrors the server default). */
export const POSTBOX_SECTION_PAGE = 20;

/** How much one "Load more" adds to a single section. */
export const POSTBOX_SECTION_PAGE_STEP = 20;

/**
 * Client-side ceiling on one section's page. Matches `MAX_SECTION_LIMIT` on the
 * server, which clamps anyway — this only stops the UI from offering a
 * "Load more" that cannot advance.
 */
export const POSTBOX_SECTION_LIMIT_MAX = 200;

/** The stable key for a section, mapping the unnamed remainder onto `''`. */
export function postboxSectionKey(name: string | null): string {
	return name ?? POSTBOX_SECTION_OTHER_KEY;
}

/** How many rows this section currently asks for. */
export function postboxSectionLimit(limits: Readonly<Record<string, number>>, key: string): number {
	return limits[key] ?? POSTBOX_SECTION_PAGE;
}

/**
 * Grow ONE section's page. Returns a new record (the caller holds it in a ref),
 * leaving every other section exactly where it was — the property that makes
 * per-section paging non-starving on the client as well as the server.
 */
export function growPostboxSection(
	limits: Readonly<Record<string, number>>,
	key: string
): Record<string, number> {
	const next = Math.min(
		postboxSectionLimit(limits, key) + POSTBOX_SECTION_PAGE_STEP,
		POSTBOX_SECTION_LIMIT_MAX
	);
	return { ...limits, [key]: next };
}

/** True once a section's page has hit the ceiling and "Load more" cannot advance. */
export function isPostboxSectionAtMax(
	limits: Readonly<Record<string, number>>,
	key: string
): boolean {
	return postboxSectionLimit(limits, key) >= POSTBOX_SECTION_LIMIT_MAX;
}

/** The limits record as the query argument the server expects. */
export function postboxSectionLimitArgs(
	limits: Readonly<Record<string, number>>
): Array<{ section: string; limit: number }> {
	return Object.entries(limits).map(([section, limit]) => ({ section, limit }));
}
