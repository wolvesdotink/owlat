/**
 * Contact resolution (module) — find-or-create from a typed signal.
 *
 * Single entry point for every "given an identifier, find or create a Contact"
 * path: inbound email, channel webhook, bulk import, HTTP API, automation
 * trigger. Behaviour forks on `mode`:
 *
 *   strict — match → throw already_exists. create otherwise.
 *   upsert — match → return matched id, no field update. create otherwise.
 *   merge  — match → patch fields where new value is non-empty
 *            (existing wins for undefined/empty). create otherwise.
 *
 * Lookup is uniform: every Contact is keyed by `contactIdentities.by_identifier`.
 * For the `email` channel, `contacts.email` is denormalized (legacy reads of
 * `contact.email` keep working) but the lookup primitive is still the identity
 * row. Soft-deleted Contacts are skipped — identifier cascade at soft-delete
 * time (lib/contactMutations.ts:softDeleteContact) guarantees no collision
 * when creating a fresh Contact for a reclaimed identifier.
 *
 * The module owns: identity row write on create, the email identity re-key
 * when a contact's address is edited (`changeContactEmail`), `searchableText`
 * computation, soft-delete filter on lookup. It does *not* own: activity
 * logging, automation trigger fanout, contact-count maintenance — those stay
 * with callers based on the returned `action`. For `merge`, the result also
 * carries the `changedProperties` diff so callers can fire the
 * `contact_updated` trigger with the correct watched-property list (the module
 * computes the diff but never fires the trigger itself).
 *
 * See docs/adr/0008-contact-resolution-module.md.
 */

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { throwAlreadyExists } from '../_utils/errors';
import { buildSearchableText } from '../lib/queryHelpers';
import type { ContactSource } from '../lib/validators/contacts';
import { recordContactGrowth } from './growthCounters';
import { linkUnresolvedFeedbackToContact } from '../webhooks/unresolvedFeedbackLinks';

// ============================================================
// Types
// ============================================================

const CHANNEL_KIND_LITERALS = ['email', 'sms', 'whatsapp', 'phone', 'generic', 'chat'] as const;

export type ChannelKind = (typeof CHANNEL_KIND_LITERALS)[number];

const RESOLVE_MODE_LITERALS = ['strict', 'upsert', 'merge'] as const;

export type ResolveMode = (typeof RESOLVE_MODE_LITERALS)[number];

/**
 * Optional Contact fields that may be set at create time and (in `merge` mode)
 * patched on match. Empty/undefined values are ignored — never overwrite a
 * user-set name with `extractNameFromEmail`-style junk.
 */
export type ContactFields = {
	firstName?: string;
	lastName?: string;
	language?: string;
	timezone?: string;
};

export type ResolveAction = 'matched' | 'created' | 'updated';

export interface ResolveResult {
	contactId: Id<'contacts'>;
	action: ResolveAction;
	/**
	 * Built-in fields whose value actually changed on a `merge` match (subset of
	 * firstName/lastName/language/timezone). Present only when `action` is
	 * `'updated'`. The module does NOT fire automation triggers itself (see the
	 * docblock above) — it surfaces the diff so callers can fire
	 * `contact_updated` with the correct watched-property list.
	 */
	changedProperties?: string[];
}

// ============================================================
// Lookup primitive
// ============================================================

/**
 * Find a live Contact (and its identity row) by `(channel, identifier)`.
 * Returns null if no row matches or the matched Contact is soft-deleted.
 *
 * Exported for `addIdentity`, read-only lookups (Answer mode resolves the
 * contact a reply goes to inside a query) and tests; internal callers use
 * `resolveContact`.
 */
export async function findContactByIdentifier(
	ctx: Pick<QueryCtx, 'db'>,
	channel: ChannelKind,
	identifier: string
): Promise<{ contact: Doc<'contacts'>; identity: Doc<'contactIdentities'> } | null> {
	const identity = await ctx.db
		.query('contactIdentities')
		.withIndex('by_identifier', (q) => q.eq('channel', channel).eq('identifier', identifier))
		.first();

	if (!identity) return null;

	const contact = await ctx.db.get(identity.contactId);
	if (!contact || contact.deletedAt !== undefined) return null;

	return { contact, identity };
}

// ============================================================
// Resolve (internal helper — called via the exported mutation below)
// ============================================================

export interface ResolveSignal {
	channel: ChannelKind;
	identifier: string;
	source: ContactSource;
	mode: ResolveMode;
	contactFields?: ContactFields;
}

/**
 * Find-or-create a Contact. Exported so mutations can call it directly without
 * a `runMutation` round-trip.
 */
export async function resolveContact(
	ctx: MutationCtx,
	signal: ResolveSignal
): Promise<ResolveResult> {
	const identifier = normalizeIdentifier(signal.channel, signal.identifier);
	const match = await findContactByIdentifier(ctx, signal.channel, identifier);

	if (match) {
		if (signal.mode === 'strict') {
			throwAlreadyExists(`A contact with ${signal.channel}:${identifier} already exists`);
		}

		if (signal.mode === 'merge') {
			const changedProperties = await mergeFields(ctx, match.contact, signal.contactFields);
			return {
				contactId: match.contact._id,
				action: changedProperties.length > 0 ? 'updated' : 'matched',
				...(changedProperties.length > 0 ? { changedProperties } : {}),
			};
		}

		// upsert
		return { contactId: match.contact._id, action: 'matched' };
	}

	// No match — create.
	const contactId = await insertContactRow(ctx, signal, identifier);
	return { contactId, action: 'created' };
}

function normalizeIdentifier(channel: ChannelKind, identifier: string): string {
	const trimmed = identifier.trim();
	// Emails are case-insensitive. Phone-derived channels are kept verbatim —
	// callers normalize to E.164 before reaching us.
	return channel === 'email' ? trimmed.toLowerCase() : trimmed;
}

/**
 * Patch built-in fields where the new value is non-empty and differs from the
 * stored value. Returns the names of the fields that actually changed (a subset
 * of firstName/lastName/language/timezone) so the caller can fire the
 * `contact_updated` automation trigger with the right watched-property list.
 * An empty array means nothing changed.
 */
async function mergeFields(
	ctx: MutationCtx,
	existing: Doc<'contacts'>,
	contactFields: ContactFields | undefined
): Promise<string[]> {
	if (!contactFields) return [];

	const patch: Partial<Doc<'contacts'>> = {};
	const changedProperties: string[] = [];

	const newFirstName = contactFields.firstName?.trim();
	if (newFirstName && newFirstName !== existing.firstName) {
		patch.firstName = newFirstName;
		changedProperties.push('firstName');
	}

	const newLastName = contactFields.lastName?.trim();
	if (newLastName && newLastName !== existing.lastName) {
		patch.lastName = newLastName;
		changedProperties.push('lastName');
	}

	const newLanguage = contactFields.language?.trim();
	if (newLanguage && newLanguage !== existing.language) {
		patch.language = newLanguage;
		changedProperties.push('language');
	}

	const newTimezone = contactFields.timezone?.trim();
	if (newTimezone && newTimezone !== existing.timezone) {
		patch.timezone = newTimezone;
		changedProperties.push('timezone');
	}

	if (changedProperties.length === 0) return [];

	// Recompute searchableText if any name field changed.
	if (patch.firstName !== undefined || patch.lastName !== undefined) {
		patch.searchableText = buildSearchableText(
			existing.email,
			patch.firstName ?? existing.firstName,
			patch.lastName ?? existing.lastName
		);
	}

	patch.updatedAt = Date.now();
	await ctx.db.patch(existing._id, patch);
	return changedProperties;
}

async function insertContactRow(
	ctx: MutationCtx,
	signal: ResolveSignal,
	identifier: string
): Promise<Id<'contacts'>> {
	const now = Date.now();
	const fields = signal.contactFields ?? {};
	const firstName = fields.firstName?.trim() || undefined;
	const lastName = fields.lastName?.trim() || undefined;
	const language = fields.language?.trim() || undefined;
	const timezone = fields.timezone?.trim() || undefined;

	// `contacts.email` is denormalized from the email-channel identity row.
	// For non-email channels, the Contact has no email at all.
	const email = signal.channel === 'email' ? identifier : undefined;
	const searchableText = buildSearchableText(email, firstName, lastName);

	const contactId = await ctx.db.insert('contacts', {
		email,
		firstName,
		lastName,
		source: signal.source,
		language,
		timezone,
		searchableText,
		// Initial DOI status — non-optional per ADR-0009. The DOI lifecycle
		// (module) is the only later writer of this field and its companions.
		doiStatus: 'not_required',
		createdAt: now,
		updatedAt: now,
	});
	await recordContactGrowth(ctx, null, { createdAt: now });

	// Every Contact gets at least one `contactIdentities` row. The primary
	// identity is the one created here; secondary identities for the same
	// Contact go through `addIdentity` in `contacts/identities.ts`.
	await ctx.db.insert('contactIdentities', {
		contactId,
		channel: signal.channel,
		identifier,
		isPrimary: true,
		createdAt: now,
	});

	return contactId;
}

// ============================================================
// Email change — called by contacts/contactEdit.ts
// ============================================================

/**
 * Move a Contact onto a new email address and keep its identity rows in step,
 * so resolution by the new address finds this Contact and the old address is
 * free to be claimed by a new one.
 *
 * Collisions are checked against both lookups: the identity index (which also
 * catches an address another Contact holds as a *secondary* identity, e.g.
 * after a merge) and the denormalized `contacts.email` (legacy rows written
 * before every Contact had an identity row). Both are live-only, so an erased
 * gravestone never blocks reclaiming its address.
 *
 * Identity handling:
 *   - the new address is already this Contact's secondary identity → promote
 *     that row to primary and drop the old address row;
 *   - otherwise re-key the old address row (falling back to the primary email
 *     row), or insert a primary row when the Contact has none.
 *
 * Does NOT patch the contact row: the caller folds the returned `email` into
 * its single `contacts` patch together with `searchableText`.
 */
export async function changeContactEmail(
	ctx: MutationCtx,
	contact: Doc<'contacts'>,
	rawEmail: string
): Promise<{ email: string; changed: boolean }> {
	const email = normalizeIdentifier('email', rawEmail);
	if (email === contact.email) return { email, changed: false };

	const match = await findContactByIdentifier(ctx, 'email', email);
	if (match && match.contact._id !== contact._id) {
		throwAlreadyExists(`A contact with this email already exists: ${email}`);
	}
	const legacy = await ctx.db
		.query('contacts')
		.withIndex('by_email', (q) => q.eq('email', email))
		.filter((q) => q.and(q.eq(q.field('deletedAt'), undefined), q.neq(q.field('_id'), contact._id)))
		.first();
	if (legacy) {
		throwAlreadyExists(`A contact with this email already exists: ${email}`);
	}

	// The old address stops naming this contact: link the unresolved feedback
	// stored under it first, so erasing the contact still finds it (#1194).
	if (contact.email) await linkUnresolvedFeedbackToContact(ctx, contact._id, contact.email);

	const identities = await ctx.db
		.query('contactIdentities')
		.withIndex('by_contact', (q) => q.eq('contactId', contact._id))
		.collect(); // bounded: one contact's identities
	const emailIdentities = identities.filter((identity) => identity.channel === 'email');
	const oldRow =
		contact.email !== undefined
			? emailIdentities.find((identity) => identity.identifier === contact.email)
			: undefined;

	let primaryId: Id<'contactIdentities'>;
	if (match) {
		// The address was already one of this Contact's own (secondary)
		// identities: promote it and retire the old address.
		primaryId = match.identity._id;
		await ctx.db.patch(primaryId, { isPrimary: true });
		if (oldRow && oldRow._id !== primaryId) await ctx.db.delete(oldRow._id);
	} else {
		const target = oldRow ?? emailIdentities.find((identity) => identity.isPrimary);
		if (target) {
			// A re-keyed row names a different mailbox, so any verification of
			// the old address no longer applies.
			primaryId = target._id;
			await ctx.db.patch(primaryId, { identifier: email, isPrimary: true, verifiedAt: undefined });
		} else {
			primaryId = await ctx.db.insert('contactIdentities', {
				contactId: contact._id,
				channel: 'email',
				identifier: email,
				isPrimary: true,
				createdAt: Date.now(),
			});
		}
	}

	// Keep exactly one primary email identity.
	for (const identity of emailIdentities) {
		if (identity._id !== primaryId && identity._id !== oldRow?._id && identity.isPrimary) {
			await ctx.db.patch(identity._id, { isPrimary: false });
		}
	}

	return { email, changed: true };
}

// ============================================================
// Cascade hook — called by softDeleteContact
// ============================================================

/**
 * Hard-delete every `contactIdentities` row belonging to a Contact. Called
 * by `softDeleteContact` so the `(channel, identifier)` becomes immediately
 * reclaimable on day 1, not 30 days later.
 *
 * Activities/messages still cascade after the 30-day retention window via
 * the existing cleanup cron — the identifier itself is the privacy-sensitive
 * datum, not the per-Contact-id-keyed history.
 */
export async function deleteIdentitiesForContact(
	ctx: MutationCtx,
	contactId: Id<'contacts'>
): Promise<void> {
	const identities = await ctx.db
		.query('contactIdentities')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's identities

	for (const identity of identities) {
		// Once the identity is gone the erasure cannot find unresolved feedback
		// by this address, so link it to the contact while it is known (#1194).
		if (identity.channel === 'email') {
			await linkUnresolvedFeedbackToContact(ctx, contactId, identity.identifier);
		}
		await ctx.db.delete(identity._id);
	}
}
