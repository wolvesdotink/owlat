import type { Doc } from '../_generated/dataModel';
import type { ListingDescriptor } from '../lib/listing';

/**
 * A Contact row as it may leave the backend — the stored row minus its
 * capability fields. This is the type every member-readable contact read
 * returns, so a caller that reaches for a stripped field fails to compile
 * rather than silently reading `undefined`.
 */
export type PublicContact = Omit<Doc<'contacts'>, 'doiConfirmationToken' | 'doiTokenExpiresAt'>;

/**
 * Capability fields live on the Contact row but must never leave the backend on
 * a member-readable query: `doiConfirmationToken` confirms double-opt-in for
 * the contact, so anyone holding it can fabricate consent evidence via the
 * public confirm endpoints. GDPR export and form-submission reads already
 * strip them; this redactor is the same contract applied to every listing row.
 */
export function redactContactCapabilityFields<
	T extends {
		doiConfirmationToken?: string;
		doiTokenExpiresAt?: number;
	},
>(contact: T): Omit<T, 'doiConfirmationToken' | 'doiTokenExpiresAt'> {
	const { doiConfirmationToken: _token, doiTokenExpiresAt: _expiresAt, ...publicContact } = contact;
	return publicContact;
}

/**
 * Contact listing descriptor (ADR-0037). The cleanest case: the
 * `search_contacts` index already exists, so search is genuinely multi-page via
 * a real Convex cursor (the `'search'` sentinel dies), soft-delete rides the
 * index on both paths, and the total is the denormalized `instanceSettings`
 * counter.
 *
 * The generics spell out "no enrichment, rows redacted to `PublicContact`": the
 * page's row type is the redacted one, so the capability strip is enforced by
 * the compiler at every call site, not just at runtime by the engine.
 */
type ContactListing = ListingDescriptor<'contacts', Record<never, never>, PublicContact>;

export const contactListing: ContactListing = {
	table: 'contacts',
	search: { index: 'search_contacts', field: 'searchableText', filterFields: ['deletedAt'] },
	// The default browse index is already createdAt-ordered, so `createdAt` is a
	// legal `sort` arg with no `sortIndexes` swap needed; the page's `order` arg
	// flips asc/desc on it. Email/name have no soft-delete-leading index, so they
	// are deliberately not server-sortable (a post-filter would thin pages).
	browse: { index: 'by_deleted_at_and_created_at', order: 'desc' },
	sortKeys: ['createdAt'],
	softDelete: true,
	redact: redactContactCapabilityFields,
	facets: {
		total: { kind: 'cachedCounter', table: 'instanceSettings', field: 'contactCount' },
	},
};
