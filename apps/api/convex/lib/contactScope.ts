import type { Id } from '../_generated/dataModel';

/**
 * Contact-visibility scope for the agent draft pipeline's semantic retrieval.
 *
 *   - <contactId>        → the message resolved to a contact; the draft may draw
 *                          on org-general rows OR rows linked to that contact.
 *   - 'org-general-only' → the message has no resolved contact, so we cannot
 *                          scope to one; restrict to org-general rows (fail
 *                          closed rather than expose every contact's data).
 *
 * `undefined` (no scoping) is intentionally NOT part of this type — callers that
 * legitimately read org-wide (the trusted-member assistant path) pass the
 * explicit `'org-wide'` sentinel of `RetrievalScope` instead, so a forgotten arg
 * can never silently fall back to org-wide.
 */
export type ContactScope = Id<'contacts'> | 'org-general-only';

/**
 * The scope a caller passes to the agent-facing semantic search. It is a
 * REQUIRED arg (never optional) so retrieval is always an explicit decision:
 *   - <contactId> / 'org-general-only' → filtered via `isContactScopeVisible`.
 *   - 'org-wide'                        → no filter (the trusted-member
 *                                         assistant path, allowed to read
 *                                         across all contacts).
 * Making 'org-wide' an explicit opt-in — rather than the default of an omitted
 * arg — is what stops a new retrieval path from re-introducing the cross-contact
 * leak by simply forgetting to scope.
 */
export type RetrievalScope = ContactScope | 'org-wide';

/**
 * The data-isolation rule shared by knowledge + semantic-file retrieval.
 *
 * Convex vector indexes cannot filter array fields like `contactIds`, so the
 * agent draft path over-fetches a candidate pool and post-filters with this
 * predicate. A row is visible when it is org-general (no `contactIds`) or, for a
 * specific-contact scope, when it is linked to that contact. A reply drafted for
 * contact A must never surface a row linked exclusively to contact B.
 */
export function isContactScopeVisible(
	contactIds: Id<'contacts'>[] | undefined,
	scope: ContactScope,
): boolean {
	if (!contactIds || contactIds.length === 0) return true;
	if (scope === 'org-general-only') return false;
	return contactIds.includes(scope);
}

/**
 * Construction-side companion to {@link isContactScopeVisible}: may a structural
 * edge be drawn between two knowledge nodes without bridging contact A → contact
 * B? True when either node is org-general (no `contactIds`, universally visible)
 * or the two contact sets intersect.
 *
 * The deterministic linker creates edges at INGEST, where `isContactScopeVisible`
 * (which takes a single retrieval scope) does not fit — both endpoints carry a
 * `contactIds` array. This is the construction-time analogue: it refuses an edge
 * between two disjoint, contact-specific nodes so an auto-built edge can never
 * become a covert A→B bridge that a later traversal would have to undo. Two
 * nodes extracted from the same source share the source's `contactIds`, so a
 * same-source clique always passes; only the cross-source / same-thread fanout
 * can be blocked here.
 */
export function contactScopesCanLink(
	a: Id<'contacts'>[] | undefined,
	b: Id<'contacts'>[] | undefined,
): boolean {
	if (!a || a.length === 0) return true;
	if (!b || b.length === 0) return true;
	const bset = new Set(b);
	return a.some((id) => bset.has(id));
}

/**
 * Do two knowledge nodes carry the SAME contact scope — the same set of
 * `contactIds`, with undefined/empty both meaning org-general? The content-hash
 * write-dedup in `knowledge.graph.saveEntry` collapses two byte-identical entries
 * only when this holds, so returning the pre-existing row can never widen or
 * narrow the fact's contact visibility (e.g. fold an org-general write into a
 * contact-A row, or vice versa).
 */
export function sameContactScope(
	a: Id<'contacts'>[] | undefined,
	b: Id<'contacts'>[] | undefined,
): boolean {
	const aset = new Set(a ?? []);
	const bset = new Set(b ?? []);
	if (aset.size !== bset.size) return false;
	for (const id of aset) if (!bset.has(id)) return false;
	return true;
}
