/**
 * Contact Identities
 *
 * Multi-channel identity unification for contacts.
 * Manages identities across email, phone, WhatsApp, social handles,
 * and provides merge suggestions when duplicates are detected.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import type { Doc } from '../_generated/dataModel';
import { throwAlreadyExists, throwNotFound } from '../_utils/errors';
import { logInfo } from '../lib/runtimeLog';
import { mergeContactRelations } from '../lib/contactMutations';
import { decrementContactCount } from '../lib/contactCountHelpers';
import { recordAuditLog } from '../lib/auditLog';

// ============================================================
// Queries
// ============================================================

/**
 * Get all identities for a contact
 */
export const listByContact = authedQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		return await ctx.db
			.query('contactIdentities')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.collect(); // bounded: one contact's identities
	},
});

/**
 * Look up a contact by channel + identifier
 */
export const findByIdentifier = authedQuery({
	args: {
		channel: v.string(),
		identifier: v.string(),
	},
	handler: async (ctx, args) => {
		const identity = await ctx.db
			.query('contactIdentities')
			.withIndex('by_identifier', (q) =>
				q.eq('channel', args.channel).eq('identifier', args.identifier)
			)
			.first();

		if (!identity) return null;

		const contact = await ctx.db.get(identity.contactId);
		return contact ? { identity, contact } : null;
	},
});

/**
 * Find potential merge candidates for a contact.
 * Returns other contacts that share identifiers with the given contact.
 */
export const getMergeSuggestions = authedQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact) return [];

		const identities = await ctx.db
			.query('contactIdentities')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.collect(); // bounded: one contact's identities

		const candidateIds = new Set<string>();
		const suggestions: Array<{
			contact: Doc<'contacts'>;
			matchedIdentities: Array<{ channel: string; identifier: string }>;
		}> = [];

		for (const identity of identities) {
			// Find other contacts with similar identifiers
			// e.g., same phone number on different channels, same email domain patterns
			const matches = await ctx.db
				.query('contactIdentities')
				.withIndex('by_identifier', (q) =>
					q.eq('channel', identity.channel).eq('identifier', identity.identifier)
				)
				.collect(); // bounded: identities for one identifier (≈1 row)

			for (const match of matches) {
				if (match.contactId === args.contactId) continue;
				const key = match.contactId as string;
				if (candidateIds.has(key)) continue;
				candidateIds.add(key);

				const candidateContact = await ctx.db.get(match.contactId);
				if (!candidateContact) continue;

				// Gather all shared identities
				const candidateIdentities = await ctx.db
					.query('contactIdentities')
					.withIndex('by_contact', (q) => q.eq('contactId', match.contactId))
					.collect(); // bounded: one contact's identities

				const shared = candidateIdentities.filter((ci) =>
					identities.some((i) => i.channel === ci.channel && i.identifier === ci.identifier)
				);

				suggestions.push({
					contact: candidateContact,
					matchedIdentities: shared.map((s) => ({
						channel: s.channel,
						identifier: s.identifier,
					})),
				});
			}
		}

		return suggestions;
	},
});

// ============================================================
// Mutations
// ============================================================

/**
 * Add an identity to a contact
 */
export const addIdentity = authedMutation({
	args: {
		contactId: v.id('contacts'),
		channel: v.string(),
		identifier: v.string(),
		isPrimary: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'contacts:manage', 'Only owners and admins can manage contacts');

		// Check for existing identity with same channel+identifier
		const existing = await ctx.db
			.query('contactIdentities')
			.withIndex('by_identifier', (q) =>
				q.eq('channel', args.channel).eq('identifier', args.identifier)
			)
			.first();

		if (existing) {
			if (existing.contactId === args.contactId) {
				return existing._id; // Already linked
			}
			throwAlreadyExists(
				`Identity ${args.channel}:${args.identifier} is already linked to another contact`
			);
		}

		// If setting as primary, unset other primaries for this channel
		if (args.isPrimary) {
			const contactIdentities = await ctx.db
				.query('contactIdentities')
				.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
				.collect(); // bounded: one contact's identities

			for (const ci of contactIdentities) {
				if (ci.channel === args.channel && ci.isPrimary) {
					await ctx.db.patch(ci._id, { isPrimary: false });
				}
			}
		}

		return await ctx.db.insert('contactIdentities', {
			contactId: args.contactId,
			channel: args.channel,
			identifier: args.identifier,
			isPrimary: args.isPrimary ?? false,
			createdAt: Date.now(),
		});
	},
});

/**
 * Remove an identity from a contact
 */
export const removeIdentity = authedMutation({
	args: { identityId: v.id('contactIdentities') },
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'contacts:manage', 'Only owners and admins can manage contacts');

		await ctx.db.delete(args.identityId);
	},
});

/**
 * Mark an identity as verified
 */
export const verifyIdentity = authedMutation({
	args: { identityId: v.id('contactIdentities') },
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'contacts:manage', 'Only owners and admins can manage contacts');

		await ctx.db.patch(args.identityId, { verifiedAt: Date.now() });
	},
});

/**
 * Merge two contacts: move all identities from source to target,
 * then delete the source contact.
 */
export const mergeContacts = authedMutation({
	args: {
		targetContactId: v.id('contacts'),
		sourceContactId: v.id('contacts'),
	},
	handler: async (ctx, args) => {
		const { userId } = await requireOrgPermission(ctx, 'contacts:manage', 'Only owners and admins can manage contacts');

		const target = await ctx.db.get(args.targetContactId);
		const source = await ctx.db.get(args.sourceContactId);
		if (!target || !source) throwNotFound('Contact');

		// Repoint EVERY contact-owned row (identities, relationships, topic
		// memberships, property values, activities, sends, automation runs, form
		// submissions, inbound/unified messages, threads) from source onto target,
		// deduping where a per-contact constraint exists. Single source of truth
		// for the FK list lives next to the delete cascade so the two can't drift.
		await mergeContactRelations(ctx, args.targetContactId, args.sourceContactId);

		// Merge name fields if target is missing them
		if (!target.firstName && source.firstName) {
			await ctx.db.patch(args.targetContactId, { firstName: source.firstName });
		}
		if (!target.lastName && source.lastName) {
			await ctx.db.patch(args.targetContactId, { lastName: source.lastName });
		}

		// Audit the irreversible merge BEFORE the source row leaves the table —
		// a hard-delete with no forensic trail is exactly what the audit log
		// exists to prevent.
		await recordAuditLog(ctx, {
			userId,
			action: 'contact.merged',
			resource: 'contact',
			resourceId: args.targetContactId,
			details: {
				sourceContactId: args.sourceContactId,
				sourceEmail: source.email ?? null,
			},
		});

		// Delete source contact — the row leaves the table, so keep the cached
		// count in sync exactly like softDeleteContact does.
		await ctx.db.delete(args.sourceContactId);
		await decrementContactCount(ctx, 1);

		return args.targetContactId;
	},
});

// ============================================================
// Automated de-duplication
// ============================================================

/**
 * Channels treated as STRONG/unambiguous identity signals. An exact
 * `(channel, identifier)` collision on one of these uniquely identifies a
 * person (a verified inbox address or a phone number), so two contacts sharing
 * it are safe to merge automatically. Weak/social channels (twitter, generic,
 * chat handles) are intentionally excluded — handle collisions there are not
 * reliable enough for an unattended merge.
 */
const STRONG_MERGE_CHANNELS = new Set<string>(['email', 'phone', 'sms', 'whatsapp']);

/**
 * Inline the merge logic from `mergeContacts` without the auth/permission
 * gate. Repoints every contact-owned row from `source` onto `target` via the
 * shared `mergeContactRelations` cascade — identities, relationships, topic
 * memberships, property values, activities, email/transactional sends,
 * automation runs, form submissions, and inbound/unified messages — backfills
 * missing name fields, then hard-deletes the source contact.
 *
 * Shares the exact cascade table list with `mergeContacts` (both call
 * `mergeContactRelations`) and with the permanent-delete path (both reference
 * `CONTACT_REPOINT_TABLES` in lib/contactMutations.ts), so no referencing row
 * is ever orphaned by the merge. Kept private (no export) so the only
 * unauthenticated entry point is the bounded mutation below. Merge is the one
 * path that genuinely destroys a duplicate rather than soft-deleting it.
 */
async function mergeContactInto(
	ctx: MutationCtx,
	targetContactId: Doc<'contacts'>['_id'],
	sourceContactId: Doc<'contacts'>['_id'],
): Promise<void> {
	const target = await ctx.db.get(targetContactId);
	const source = await ctx.db.get(sourceContactId);
	if (!target || !source) return;

	await mergeContactRelations(ctx, targetContactId, sourceContactId);

	if (!target.firstName && source.firstName) {
		await ctx.db.patch(targetContactId, { firstName: source.firstName });
	}
	if (!target.lastName && source.lastName) {
		await ctx.db.patch(targetContactId, { lastName: source.lastName });
	}

	await ctx.db.delete(sourceContactId);
	await decrementContactCount(ctx, 1);
}

/**
 * Auto-merge high-confidence duplicate contacts.
 *
 * Walks identity rows on STRONG channels (email / phone / sms / whatsapp),
 * groups them by exact `(channel, identifier)`, and for any identifier shared
 * by more than one live contact merges the extras into the oldest contact
 * (lowest `_creationTime` = canonical survivor). Only EXACT collisions on a
 * strong channel qualify — this is the unambiguous-duplicate subset of what
 * `getMergeSuggestions` surfaces, so no fuzzy/social matches are ever merged.
 *
 * Safe to run repeatedly: each merge folds the source's identities onto the
 * target and removes the source, so once an identifier is held by a single
 * contact it stops appearing as a collision — zero strong-channel collisions
 * is a fixed point. (Soft-deleted contacts that still have stray identity rows
 * are also skipped.) Bounded by `limit` merges per invocation (default 20) so
 * a backlog drains over several cron ticks without a single long transaction.
 *
 * No feature-flag gate: there is no contacts/CRM flag in the shared flag set,
 * and gating an always-safe hygiene job behind an unrelated flag would be
 * misleading. Add a dedicated flag here if one is introduced.
 */
export const autoMergeDuplicates = internalMutation({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const limit = Math.max(1, Math.min(args.limit ?? 20, 200));

		// Scan strong-channel identities, grouped by exact (channel, identifier).
		// `identifier` is already normalized at write time (emails lowercased in
		// the resolution module), so equality here is the unambiguous match.
		const seen = new Map<string, Doc<'contactIdentities'>[]>();
		for (const channel of STRONG_MERGE_CHANNELS) {
			const rows = await ctx.db
				.query('contactIdentities')
				.withIndex('by_identifier', (q) => q.eq('channel', channel))
				.collect(); // bounded: identities for one identifier (≈1 row)
			for (const row of rows) {
				const key = `${row.channel} ${row.identifier}`;
				const bucket = seen.get(key);
				if (bucket) bucket.push(row);
				else seen.set(key, [row]);
			}
		}

		// Track contacts already consumed in this run so we never merge a source
		// that a prior merge in the same invocation already folded away, and never
		// merge into a target that was itself merged away.
		const consumed = new Set<string>();
		let merged = 0;

		for (const rows of seen.values()) {
			if (merged >= limit) break;
			if (rows.length < 2) continue;

			// Resolve to distinct, live contacts. Multiple identity rows can point
			// at the same contact (e.g. duplicate channels) — collapse those first.
			const contactById = new Map<string, Doc<'contacts'>>();
			for (const row of rows) {
				const id = row.contactId as string;
				if (contactById.has(id) || consumed.has(id)) continue;
				const contact = await ctx.db.get(row.contactId);
				if (!contact || contact.deletedAt !== undefined) continue;
				contactById.set(id, contact);
			}
			if (contactById.size < 2) continue;

			// Oldest contact survives; everyone else folds into it.
			const contacts = [...contactById.values()].sort(
				(a, b) => a._creationTime - b._creationTime,
			);
			const target = contacts[0];
			if (!target) continue; // unreachable (size >= 2 guarded above); satisfies the checker

			for (const source of contacts.slice(1)) {
				if (merged >= limit) break;
				if (consumed.has(source._id as string)) continue;
				await mergeContactInto(ctx, target._id, source._id);
				consumed.add(source._id as string);
				merged++;
			}
		}

		if (merged > 0) {
			logInfo('[autoMergeDuplicates] merged duplicate contacts', { merged });
		}
		return { merged };
	},
});

/**
 * Ensure a contact has an identity for their email (bootstrap existing contacts)
 */
export const ensureEmailIdentity = internalMutation({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);
		// No-op for contacts without an email (phone/SMS/WhatsApp/generic-only).
		if (!contact || !contact.email) return;
		const email = contact.email;

		const existing = await ctx.db
			.query('contactIdentities')
			.withIndex('by_identifier', (q) =>
				q.eq('channel', 'email').eq('identifier', email)
			)
			.first();

		if (existing) return existing._id;

		return await ctx.db.insert('contactIdentities', {
			contactId: args.contactId,
			channel: 'email',
			identifier: email,
			isPrimary: true,
			createdAt: Date.now(),
		});
	},
});
