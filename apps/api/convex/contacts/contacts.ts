import { v } from 'convex/values';
import { internalQuery, internalMutation } from '../_generated/server';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import type { Id } from '../_generated/dataModel';
import type { ImportOutcome } from './import';
import { paginationOptsValidator } from 'convex/server';
import { internal } from '../_generated/api';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { buildSearchableText } from '../lib/queryHelpers';
import { listResources, countFacet } from '../lib/listing';
import { contactListing } from './listing';
import { topicListing } from '../topics/listing';
import { contactCreateSourceValidator } from './resolution';
import { segmentListing } from '../segments/listing';
import {
	reconcileContactCount,
} from '../lib/contactCountHelpers';
import {
	softDeleteContact,
	permanentlyDeleteContactWithRelations,
} from '../lib/contactMutations';
import { recordAuditLog } from '../lib/auditLog';
import { trackEvent } from '../lib/posthogHelpers';
import { validateStringLength, normalizeEmail, STRING_LIMITS } from '../lib/inputGuards';
import { throwNotFound, throwAlreadyExists, throwInvalidInput } from '../_utils/errors';
import { createContact } from './creation';

// Query to get a single contact by ID (session-authenticated client callers).
export const get = authedQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);
		// Don't surface soft-deleted contacts (e.g. a GDPR erasure still inside
		// the retention window before the hard-delete cron runs).
		if (!contact || contact.deletedAt !== undefined) {
			return null;
		}
		return contact;
	},
});

// Resolve a batch of contacts by id (session-authenticated client callers),
// skipping soft-deleted and missing rows. Bounded by the input array, which is
// a small UI-supplied list (e.g. a file's linked-contact ids). Used to hydrate
// chips/labels for already-stored contact id arrays without N round-trips.
// all-members: contact name/email is org-wide and visible to any member, same as
// the single `get` above; returns only display fields, no sensitive properties.
export const getByIds = authedQuery({
	args: { contactIds: v.array(v.id('contacts')) },
	handler: async (ctx, args) => {
		const out: Array<{ _id: Id<'contacts'>; email?: string; firstName?: string; lastName?: string }> = [];
		for (const contactId of args.contactIds) {
			const contact = await ctx.db.get(contactId);
			if (!contact || contact.deletedAt !== undefined) continue;
			out.push({
				_id: contact._id,
				email: contact.email,
				firstName: contact.firstName,
				lastName: contact.lastName,
			});
		}
		return out;
	},
});

// Internal variant for server-side callers that authenticate by a different
// means than a session — chiefly the API-key-authenticated REST handlers in
// `contacts/api.ts` and `topics/apiHttp.ts`, which run as actions with no
// Convex session and therefore cannot call the session-gated `get` above.
export const getInternal = internalQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.contactId);
	},
});

// ==========================================
// SESSION-BASED QUERIES (US-404)
// These queries use BetterAuth session for auth.
// ==========================================

/**
 * List contacts with cursor-based pagination. Thin session-auth shell over the
 * Listing engine — search is relevance-ordered and genuinely multi-page (the
 * `'search'` sentinel is gone), soft-delete rides the index. See ADR-0037.
 */
export const list = authedQuery({
	args: {
		search: v.optional(v.string()),
		// Browse-path sort. Only `createdAt` has a soft-delete-leading index, so
		// it is the sole server-sortable key; `order` flips asc/desc on it. Both
		// are ignored on the search path (relevance order). See contacts/listing.ts.
		sort: v.optional(v.literal('createdAt')),
		order: v.optional(v.union(v.literal('asc'), v.literal('desc'))),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) =>
		listResources(ctx.db, contactListing, {
			search: args.search,
			sort: args.sort,
			order: args.order,
			paginationOpts: args.paginationOpts,
		}),
});

/**
 * Get total count of contacts — the descriptor's `total` facet (a denormalized
 * `instanceSettings` counter with a bounded-scan fallback).
 */
export const count = authedQuery({
	args: {},
	handler: async (ctx) => {
		const total = await countFacet(ctx.db, contactListing, 'total');
		return total as number;
	},
});

/**
 * Get audience stats — composes the `total` facet of three descriptors.
 */
export const getAudienceStats = authedQuery({
	args: {},
	handler: async (ctx) => {
		const [totalContacts, topicCount, segmentCount] = await Promise.all([
			countFacet(ctx.db, contactListing, 'total'),
			countFacet(ctx.db, topicListing, 'total'),
			countFacet(ctx.db, segmentListing, 'total'),
		]);

		return {
			totalContacts: totalContacts as number,
			topicCount: topicCount as number,
			segmentCount: segmentCount as number,
		};
	},
});

// ==========================================
// SESSION-BASED MUTATIONS (US-405)
// These mutations use BetterAuth session for auth.
// ==========================================

/**
 * Create a new contact.
 */
export const create = authedMutation({
	args: {
		email: v.string(),
		firstName: v.optional(v.string()),
		lastName: v.optional(v.string()),
		source: v.optional(contactCreateSourceValidator),
		language: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		// Validate input lengths
		validateStringLength(args.email, STRING_LIMITS.NAME, 'Email');
		if (args.firstName) validateStringLength(args.firstName, STRING_LIMITS.NAME, 'First name');
		if (args.lastName) validateStringLength(args.lastName, STRING_LIMITS.NAME, 'Last name');

		const session = await requireOrgPermission(ctx, 'contacts:manage', 'Only owners and admins can create contacts');

		const email = normalizeEmail(args.email);
		const { contactId } = await createContact(ctx, {
			channel: 'email',
			identifier: email,
			source: args.source ?? 'api',
			mode: 'strict',
			contactFields: {
				firstName: args.firstName,
				lastName: args.lastName,
				language: args.language,
			},
		});

		await trackEvent(ctx, session, 'contact_created');

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'contact.created',
			resource: 'contact',
			resourceId: contactId,
			details: { email },
		});

		return contactId;
	},
});

/**
 * Update a contact.
 */
export const update = authedMutation({
	args: {
		contactId: v.id('contacts'),
		email: v.optional(v.string()),
		firstName: v.optional(v.string()),
		lastName: v.optional(v.string()),
		timezone: v.optional(v.string()),
		language: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);

		const session = await requireOrgPermission(ctx, 'contacts:manage', 'Only owners and admins can update contacts');

		if (!contact) {
			throwNotFound('Contact');
		}

		// Bound input lengths the same way create() does — update was skipping it.
		if (args.email !== undefined) validateStringLength(args.email, STRING_LIMITS.NAME, 'Email');
		if (args.firstName !== undefined) validateStringLength(args.firstName, STRING_LIMITS.NAME, 'First name');
		if (args.lastName !== undefined) validateStringLength(args.lastName, STRING_LIMITS.NAME, 'Last name');

		const now = Date.now();
		const updates: {
			email?: string;
			firstName?: string;
			lastName?: string;
			timezone?: string;
			language?: string;
			searchableText?: string;
			updatedAt: number;
		} = { updatedAt: now };

		// Track which properties changed for automation triggers
		const changedProperties: string[] = [];

		if (args.email !== undefined) {
			const email = normalizeEmail(args.email);
			// Check for duplicate email if changing
			if (email !== contact.email) {
				// Only a LIVE contact blocks reuse of the address. A soft-deleted
				// (GDPR-erased) gravestone keeps its email but must not prevent
				// reclaiming it — match resolveContact's live-only lookup.
				const existing = await ctx.db
					.query('contacts')
					.withIndex('by_email', (q) =>
						q.eq('email', email)
					)
					.filter((q) => q.eq(q.field('deletedAt'), undefined))
					.first();
				if (existing) {
					throwAlreadyExists(`A contact with this email already exists: ${email}`);
				}
				changedProperties.push('email');
			}
			updates.email = email;
		}

		if (args.firstName !== undefined) {
			if (args.firstName.trim() !== (contact.firstName ?? '')) {
				changedProperties.push('firstName');
			}
			updates.firstName = args.firstName.trim();
		}

		if (args.lastName !== undefined) {
			if (args.lastName.trim() !== (contact.lastName ?? '')) {
				changedProperties.push('lastName');
			}
			updates.lastName = args.lastName.trim();
		}

		if (args.timezone !== undefined) {
			if (args.timezone !== (contact.timezone ?? '')) {
				changedProperties.push('timezone');
			}
			updates.timezone = args.timezone || undefined;
		}

		if (args.language !== undefined) {
			if (args.language !== (contact.language ?? '')) {
				changedProperties.push('language');
			}
			updates.language = args.language || undefined;
		}

		// Update searchableText if any searchable field changed
		if (args.email !== undefined || args.firstName !== undefined || args.lastName !== undefined) {
			const newEmail = updates.email ?? contact.email;
			const newFirstName = updates.firstName ?? contact.firstName ?? '';
			const newLastName = updates.lastName ?? contact.lastName ?? '';
			updates.searchableText = buildSearchableText(newEmail, newFirstName, newLastName);
		}

		await ctx.db.patch(args.contactId, updates);

		// Audit the edit (the documented contact.updated action was never emitted
		// from this handler), recording which properties changed.
		if (changedProperties.length > 0) {
			await recordAuditLog(ctx, {
				userId: session.userId,
				action: 'contact.updated',
				resource: 'contact',
				resourceId: args.contactId,
				details: { changedProperties: changedProperties.join(', ') },
			});
		}

		// Fire contact_updated automation trigger if any properties changed
		if (changedProperties.length > 0) {
			await ctx.runMutation(internal.automations.triggers.fireContactUpdatedTrigger, {
				contactId: args.contactId,
				changedProperties,
			});
		}

		return args.contactId;
	},
});

/**
 * Delete a contact.
 */
export const remove = authedMutation({
	args: {
		contactId: v.id('contacts'),
	},
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);

		const session = await requireOrgPermission(ctx, 'contacts:manage', 'Only owners and admins can delete contacts');

		if (!contact) {
			throwNotFound('Contact');
		}

		await softDeleteContact(ctx, args.contactId, session.userId);

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'contact.deleted',
			resource: 'contact',
			resourceId: args.contactId,
			details: { email: contact.email ?? null },
		});
	},
});

/**
 * Bulk delete contacts.
 * Capped at 100 contacts per call to avoid transaction timeouts.
 * For larger batches, call this mutation multiple times from the frontend.
 */
export const bulkDelete = authedMutation({
	args: {
		contactIds: v.array(v.id('contacts')),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(ctx, 'contacts:manage', 'Only owners and admins can delete contacts');

		// Cap at 100 contacts per mutation to avoid transaction timeouts
		if (args.contactIds.length > 100) {
			throwInvalidInput('Cannot delete more than 100 contacts at once. Please batch your requests.');
		}

		let deleted = 0;
		let failed = 0;
		const errors: string[] = [];
		const validContacts: { id: Id<'contacts'>; email: string | null }[] = [];

		for (const contactId of args.contactIds) {
			const contact = await ctx.db.get(contactId);
			if (!contact) {
				failed++;
				errors.push(`Contact ${contactId} not found`);
				continue;
			}

			validContacts.push({ id: contactId, email: contact.email ?? null });
		}

		for (const { id, email } of validContacts) {
			await softDeleteContact(ctx, id, session.userId);
			// Audit each deletion (mirrors remove()) — a bulk erase of PII rows
			// is exactly what the audit trail exists to capture.
			await recordAuditLog(ctx, {
				userId: session.userId,
				action: 'contact.deleted',
				resource: 'contact',
				resourceId: id,
				details: { email },
			});
			deleted++;
		}

		return { deleted, failed, errors: errors.length > 0 ? errors : undefined };
	},
});

/**
 * Import contacts in batch.
 *
 * Auth + topicAssignments shape + dispatch shell. The composition (resolve,
 * property writes, activity, DOI attest, per-topic subscribe coalescing,
 * count increment) lives in the **Contact import (module)** at
 * `convex/contacts/import.ts`. See ADR-0019.
 */
export const importBatch = authedMutation({
	args: {
		contacts: v.array(
			v.object({
				email: v.string(),
				firstName: v.optional(v.string()),
				lastName: v.optional(v.string()),
				language: v.optional(v.string()),
				properties: v.optional(
					v.record(
						v.string(),
						v.union(v.string(), v.number(), v.boolean(), v.null()),
					),
				),
			})
		),
		handleDuplicates: v.union(v.literal('skip'), v.literal('update')),
		topicId: v.optional(v.id('topics')),
		contactListAssignments: v.optional(v.array(v.object({
			email: v.string(),
			topicIds: v.array(v.id('topics')),
		}))),
		// Admin-attest: imported contacts arrive already DOI-confirmed at a
		// source platform. Gated by the same `contacts:manage` permission as
		// the rest of import on this shell. See ADR-0019.
		doiAttest: v.optional(
			v.object({
				attestSource: v.string(),
			}),
		),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(ctx, 'contacts:manage', 'Only owners and admins can import contacts');

		// Validate topic exists if provided
		if (args.topicId) {
			const list = await ctx.db.get(args.topicId);
			if (!list) {
				throwInvalidInput('Topic not found');
			}
		}

		// Collapse the two topic-assignment input shapes into the import
		// module's `topicAssignments` discriminator.
		const topicAssignments = (() => {
			if (args.contactListAssignments && args.contactListAssignments.length > 0) {
				const map: Record<string, Id<'topics'>[]> = {};
				for (const a of args.contactListAssignments) {
					map[normalizeEmail(a.email)] = a.topicIds;
				}
				// When both topicId and per-row assignments are present, fold
				// topicId into every row's list (preserves legacy semantics).
				if (args.topicId) {
					for (const email of Object.keys(map)) {
						map[email] = [args.topicId, ...map[email]!];
					}
				}
				return { kind: 'per_row' as const, map };
			}
			if (args.topicId) {
				return { kind: 'single' as const, topicId: args.topicId };
			}
			return undefined;
		})();

		const importResult: ImportOutcome = await ctx.runMutation(
			internal.contacts.import.importBatch,
			{
				rows: args.contacts,
				source: 'csv',
				handleDuplicates: args.handleDuplicates,
				...(topicAssignments ? { topicAssignments } : {}),
				...(args.doiAttest
					? {
							doiAttest: {
								attestSource: args.doiAttest.attestSource,
								triggeredBy: session.userId,
							},
						}
					: {}),
			},
		);

		// Preserve the legacy return shape callers expect.
		return {
			imported: importResult.imported,
			updated: importResult.updated,
			skipped: importResult.skipped,
			failed: importResult.failed,
			errors: importResult.errors,
			addedToList: importResult.addedToTopics,
			propertiesSet: importResult.propertiesSet,
			propertiesAutoRegistered: importResult.propertiesAutoRegistered,
			propertiesSkipped: importResult.propertiesSkipped,
		};
	},
});

// ==========================================
// TEAM-LEVEL MUTATIONS (used by HTTP action handlers)
// These accept parameters instead of deriving from session,
// since HTTP actions run outside BetterAuth session context.
// ==========================================

/**
 * Get a contact by email (used by HTTP action handlers).
 * Internal only — callers must handle authorization.
 */
export const getByEmailForTeam = internalQuery({
	args: {
		email: v.string(),
	},
	handler: async (ctx, args) => {
		// Ignore soft-deleted (GDPR-erased) gravestones: their email lingers
		// on the row, so an unfiltered .first() would resolve a deleted contact
		// and disagree with the soft-delete contract (and break
		// createContactIfNotExists in the events/API path, which expects an
		// erased contact to read as absent and be recreatable).
		return await ctx.db
			.query('contacts')
			.withIndex('by_email', (q) =>
				q.eq('email', normalizeEmail(args.email))
			)
			.filter((q) => q.eq(q.field('deletedAt'), undefined))
			.first();
	},
});

/**
 * Create a contact (used by HTTP action handlers).
 * Internal only — callers must handle authorization.
 */
export const createForTeam = internalMutation({
	args: {
		email: v.string(),
		firstName: v.optional(v.string()),
		lastName: v.optional(v.string()),
		source: v.optional(contactCreateSourceValidator),
		language: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		// Validate input lengths
		validateStringLength(args.email, STRING_LIMITS.NAME, 'Email');
		if (args.firstName) validateStringLength(args.firstName, STRING_LIMITS.NAME, 'First name');
		if (args.lastName) validateStringLength(args.lastName, STRING_LIMITS.NAME, 'Last name');

		const { contactId } = await createContact(ctx, {
			channel: 'email',
			identifier: args.email,
			source: args.source ?? 'api',
			mode: 'strict',
			contactFields: {
				firstName: args.firstName,
				lastName: args.lastName,
				language: args.language,
			},
		});

		return contactId;
	},
});

/**
 * Update a contact (used by HTTP action handlers).
 * Internal only — callers must handle authorization.
 */
export const updateForTeam = internalMutation({
	args: {
		contactId: v.id('contacts'),
		email: v.optional(v.string()),
		firstName: v.optional(v.string()),
		lastName: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact) {
			throwNotFound('Contact');
		}

		const now = Date.now();
		const updates: {
			email?: string;
			firstName?: string;
			lastName?: string;
			searchableText?: string;
			updatedAt: number;
		} = { updatedAt: now };

		// Track which built-in fields actually changed so the `contact_updated`
		// automation trigger fires with the right watched-property list — the
		// public v1 HTTP API (PUT /api/v1/contacts/{id}) must honor it the same
		// way the dashboard edit does.
		const changedProperties: string[] = [];

		if (args.email !== undefined) {
			const email = normalizeEmail(args.email);
			if (email !== contact.email) {
				// Only a LIVE contact blocks reuse of the address. A soft-deleted
				// (GDPR-erased) gravestone keeps its email but must not prevent
				// reclaiming it — match resolveContact's live-only lookup.
				const existing = await ctx.db
					.query('contacts')
					.withIndex('by_email', (q) =>
						q.eq('email', email)
					)
					.filter((q) => q.eq(q.field('deletedAt'), undefined))
					.first();
				if (existing) {
					throwAlreadyExists(`A contact with this email already exists: ${email}`);
				}
				changedProperties.push('email');
			}
			updates.email = email;
		}

		if (args.firstName !== undefined) {
			if (args.firstName.trim() !== (contact.firstName ?? '')) {
				changedProperties.push('firstName');
			}
			updates.firstName = args.firstName.trim();
		}

		if (args.lastName !== undefined) {
			if (args.lastName.trim() !== (contact.lastName ?? '')) {
				changedProperties.push('lastName');
			}
			updates.lastName = args.lastName.trim();
		}

		// Update searchableText if any searchable field changed
		if (args.email !== undefined || args.firstName !== undefined || args.lastName !== undefined) {
			const newEmail = updates.email ?? contact.email;
			const newFirstName = updates.firstName ?? contact.firstName ?? '';
			const newLastName = updates.lastName ?? contact.lastName ?? '';
			updates.searchableText = buildSearchableText(newEmail, newFirstName, newLastName);
		}

		await ctx.db.patch(args.contactId, updates);

		// Fire contact_updated automation trigger if any watched property changed.
		if (changedProperties.length > 0) {
			await ctx.runMutation(internal.automations.triggers.fireContactUpdatedTrigger, {
				contactId: args.contactId,
				changedProperties,
			});
		}

		return args.contactId;
	},
});

/**
 * Remove a contact (used by HTTP action handlers).
 * Internal only — callers must handle authorization.
 */
export const removeForTeam = internalMutation({
	args: {
		contactId: v.id('contacts'),
	},
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact) {
			throwNotFound('Contact');
		}

		// REST/API-key delete is a hard delete (no human session to attach a
		// 30-day soft-delete grace to). The UI delete (`remove` above) soft-deletes.
		await permanentlyDeleteContactWithRelations(ctx, args.contactId);
	},
});

/**
 * List contacts with cursor-based pagination (used by HTTP action handlers).
 * Internal only — callers must handle authorization.
 *
 * Thin shell over the Listing engine: the browse path is created-at-descending,
 * the search path is relevance-ordered, and soft-delete rides the index on both
 * (ADR-0037). The cursor is a real, opaque Convex cursor — no per-page re-read
 * and no 10k ceiling — so every contact is reachable. `total` is the
 * denormalized `instanceSettings` counter (bounded-scan fallback).
 */
export const listByTeam = internalQuery({
	args: {
		search: v.optional(v.string()),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		const [result, total] = await Promise.all([
			listResources(ctx.db, contactListing, {
				search: args.search,
				paginationOpts: args.paginationOpts,
			}),
			countFacet(ctx.db, contactListing, 'total'),
		]);

		return {
			contacts: result.page,
			isDone: result.isDone,
			continueCursor: result.continueCursor,
			totalCount: total as number,
		};
	},
});

// ==========================================
// RECONCILIATION (P0-3)
// Internal mutations for correcting cached contact count drift.
// ==========================================

/**
 * Reconcile cached contact count.
 * Called by daily cron to correct any drift.
 */
export const reconcileContactCountInternal = internalMutation({
	args: {},
	handler: async (ctx) => {
		return await reconcileContactCount(ctx);
	},
});

/**
 * Reconcile contact counts.
 * Called by daily cron.
 */
export const reconcileAllContactCounts = internalMutation({
	args: {},
	handler: async (ctx) => {
		// Single instance — just reconcile directly
		await reconcileContactCount(ctx);
	},
});

/**
 * Permanently delete contacts whose soft-delete is older than the retention window.
 * Default 30 days. Cascades to children via permanentlyDeleteContactWithRelations.
 */
export const cleanupSoftDeletedContacts = internalMutation({
	args: {
		retentionDays: v.optional(v.number()),
		batchLimit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const retentionMs = (args.retentionDays ?? 30) * 24 * 60 * 60 * 1000;
		const cutoff = Date.now() - retentionMs;
		const limit = Math.min(args.batchLimit ?? 100, 500);

		// by_deleted_at index orders by deletedAt ascending; we want the oldest
		// soft-deleted rows below the cutoff. .filter is bounded by .take(limit).
		const expired = await ctx.db
			.query('contacts')
			.withIndex('by_deleted_at')
			.filter((q) =>
				q.and(
					q.neq(q.field('deletedAt'), undefined),
					q.lt(q.field('deletedAt'), cutoff),
				),
			)
			.take(limit);

		let purged = 0;
		for (const contact of expired) {
			// Count was decremented at soft-delete time; don't double-decrement now.
			await permanentlyDeleteContactWithRelations(ctx, contact._id, {
				decrementCount: false,
			});
			purged++;
		}

		return { purged };
	},
});
