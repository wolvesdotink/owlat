import { v } from 'convex/values';

/**
 * Open-commitment facets denormalized onto each `knowledgeEntryContacts` row,
 * so the contact-scoped open-commitments recall
 * (knowledge/graph.ts:getOpenCommitmentsByContact) reads candidates from the
 * `by_contact_open_commitment` index in due order instead of loading every
 * knowledge entry linked to the contact (issue #919).
 *
 * Written from the parent entry by knowledge/commitmentFacets.ts whenever a
 * junction row is inserted or re-parented and whenever the entry's type,
 * commitment status, due date or expiry changes. All optional (additive):
 *
 *   - `isOpenCommitment` — `true` for a `decision` / `action_item` whose status
 *     is open (absent status counts as open), `false` for every other entry.
 *     ABSENT means the row predates the projection; the reader hydrates those
 *     the old way until migration 0052 has filled them.
 *   - `commitmentDueKey` — the entry's `dueAt`, or `UNDATED_DUE_KEY` so undated
 *     commitments sort after dated ones.
 *   - `commitmentOrderKey` — `-createdAt`, so ties on the due key put the newest
 *     entry first in an ascending index walk.
 *   - `entryExpiresAt` — the entry's TTL, so an expired candidate is skipped
 *     without loading the entry.
 *
 * The three sort/TTL keys are only set on open rows.
 */
export const knowledgeEntryCommitmentFacets = {
	isOpenCommitment: v.optional(v.boolean()),
	commitmentDueKey: v.optional(v.number()),
	commitmentOrderKey: v.optional(v.number()),
	entryExpiresAt: v.optional(v.number()),
};
