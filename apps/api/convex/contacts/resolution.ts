/**
 * Contact resolution (module) — find-or-create from a typed signal.
 *
 * Single entry point for every "given an identifier, find or create a Contact"
 * path: inbound email, channel webhook, bulk import, HTTP API, automation
 * trigger. Behaviour forks on `mode`:
 *
 *   strict — match → throw ALREADY_EXISTS. create otherwise.
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
 * The module owns: identity row write on create, `searchableText` computation,
 * soft-delete filter on lookup. It does *not* own: activity logging, automation
 * trigger fanout, contact-count maintenance — those stay with callers based on
 * the returned `action`. For `merge`, the result also carries the
 * `changedProperties` diff so callers can fire the `contact_updated` trigger
 * with the correct watched-property list (the module computes the diff but
 * never fires the trigger itself).
 *
 * See docs/adr/0008-contact-resolution-module.md.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { throwAlreadyExists } from '../_utils/errors';
import { buildSearchableText } from '../lib/queryHelpers';

// ============================================================
// Types
// ============================================================

export const CHANNEL_KIND_LITERALS = [
	'email',
	'sms',
	'whatsapp',
	'phone',
	'generic',
	'chat',
] as const;

export type ChannelKind = (typeof CHANNEL_KIND_LITERALS)[number];

export const channelKindValidator = v.union(
	...CHANNEL_KIND_LITERALS.map((l) => v.literal(l)),
);

export const CONTACT_SOURCE_LITERALS = [
	'api',
	'import',
	'form',
	'transactional',
	'inbound',
] as const;

export type ContactSource = (typeof CONTACT_SOURCE_LITERALS)[number];

export const contactSourceValidator = v.union(
	...CONTACT_SOURCE_LITERALS.map((l) => v.literal(l)),
);

// Sources a caller may set when CREATING a contact. 'inbound' is excluded — it
// is assigned only internally the first time a contact appears via an inbound
// message, never accepted from the create API.
export const CONTACT_CREATE_SOURCE_LITERALS = ['api', 'import', 'form', 'transactional'] as const;

export const contactCreateSourceValidator = v.union(
	...CONTACT_CREATE_SOURCE_LITERALS.map((l) => v.literal(l)),
);

export const RESOLVE_MODE_LITERALS = ['strict', 'upsert', 'merge'] as const;

export type ResolveMode = (typeof RESOLVE_MODE_LITERALS)[number];

export const resolveModeValidator = v.union(
	...RESOLVE_MODE_LITERALS.map((l) => v.literal(l)),
);

/**
 * Optional Contact fields that may be set at create time and (in `merge` mode)
 * patched on match. Empty/undefined values are ignored — never overwrite a
 * user-set name with `extractNameFromEmail`-style junk.
 */
export const contactFieldsValidator = v.object({
	firstName: v.optional(v.string()),
	lastName: v.optional(v.string()),
	language: v.optional(v.string()),
	timezone: v.optional(v.string()),
});

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
 * Exported for `addIdentity` and tests; internal callers should use `resolve`.
 */
export async function findContactByIdentifier(
	ctx: MutationCtx,
	channel: ChannelKind,
	identifier: string,
): Promise<{ contact: Doc<'contacts'>; identity: Doc<'contactIdentities'> } | null> {
	const identity = await ctx.db
		.query('contactIdentities')
		.withIndex('by_identifier', (q) =>
			q.eq('channel', channel).eq('identifier', identifier),
		)
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
 * Find-or-create a Contact. The core implementation — exported so other
 * mutations can call it directly (avoiding the `runMutation` round-trip) but
 * the public wire shape is the `resolve` mutation below.
 */
export async function resolveContact(
	ctx: MutationCtx,
	signal: ResolveSignal,
): Promise<ResolveResult> {
	const identifier = normalizeIdentifier(signal.channel, signal.identifier);
	const match = await findContactByIdentifier(ctx, signal.channel, identifier);

	if (match) {
		if (signal.mode === 'strict') {
			throwAlreadyExists(
				`A contact with ${signal.channel}:${identifier} already exists`,
			);
		}

		if (signal.mode === 'merge') {
			const changedProperties = await mergeFields(
				ctx,
				match.contact,
				signal.contactFields,
			);
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
	contactFields: ContactFields | undefined,
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
			patch.lastName ?? existing.lastName,
		);
	}

	patch.updatedAt = Date.now();
	await ctx.db.patch(existing._id, patch);
	return changedProperties;
}

async function insertContactRow(
	ctx: MutationCtx,
	signal: ResolveSignal,
	identifier: string,
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
// Public mutation (Convex wire surface)
// ============================================================

/**
 * `resolve` — the public wire surface. Internal callers prefer
 * `resolveContact(ctx, signal)` directly to avoid the `runMutation`
 * round-trip; external/HTTP callers (`apps/api/convex/contacts/api.ts`)
 * use this mutation.
 */
export const resolve = internalMutation({
	args: {
		channel: channelKindValidator,
		identifier: v.string(),
		source: contactSourceValidator,
		mode: resolveModeValidator,
		contactFields: v.optional(contactFieldsValidator),
	},
	handler: async (ctx, args): Promise<ResolveResult> => {
		return await resolveContact(ctx, args);
	},
});

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
	contactId: Id<'contacts'>,
): Promise<void> {
	const identities = await ctx.db
		.query('contactIdentities')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's identities

	for (const identity of identities) {
		await ctx.db.delete(identity._id);
	}
}
