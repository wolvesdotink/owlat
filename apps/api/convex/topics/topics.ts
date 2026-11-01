import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { paginationOptsValidator } from 'convex/server';
import { internal } from '../_generated/api';
import { nanoid } from 'nanoid';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { countIndexRange } from '../lib/pagination';
import { getOptional } from '../lib/env';
import { listResources } from '../lib/listing';
import { topicListing } from './listing';
import { redactContactCapabilityFields } from '../contacts/listing';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { getOrThrow } from '../_utils/errors';
import { trackEvent } from '../lib/posthogHelpers';
import { batchGet } from '../_utils/batchLoader';
import { getLiveContact } from '../lib/contactHelpers';
import {
	findContactByConfirmationToken,
	isFormTokenDisabled,
	type TransitionOutcome as DoiTransitionOutcome,
	type RefreshOutcome as DoiRefreshOutcome,
} from '../contacts/doiLifecycle';
import { DOI_TOKEN_TTL_MS } from '../contacts/doiLifecycleReducer';
import { getTopicImpl, getTopicsForContactImpl, loadContactInTopicDetails } from './topicReads';
import {
	addContactArgs,
	addContactImpl,
	removeContactArgs,
	removeContactImpl,
	type AddContactResult,
} from './membershipShells';

// Query to get a single topic by ID.
// all-members: topics are campaign audiences and subscription lists every role
// reads; writing them needs topics:manage.
export const get = authedQuery({
	args: { topicId: v.id('topics') },
	handler: async (ctx, args) => getTopicImpl(ctx, args.topicId),
});

// Internal variant for the API-key REST route (topics/apiHttp.ts), which has
// no Convex session and so cannot call the session-gated `get` above.
export const getInternal = internalQuery({
	args: { topicId: v.id('topics') },
	handler: async (ctx, args) => getTopicImpl(ctx, args.topicId),
});

// Query to get contacts in a topic (paginated)
// all-members: the topic's member list, read like contacts.list; deleted
// contacts are skipped and the rest redacted below.
export const getContacts = authedQuery({
	args: {
		topicId: v.id('topics'),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		const topic = await ctx.db.get(args.topicId);
		if (!topic) return { page: [], isDone: true, continueCursor: '' };

		const result = await ctx.db
			.query('contactTopics')
			.withIndex('by_topic', (q) => q.eq('topicId', args.topicId))
			.paginate(args.paginationOpts);

		// Batch-load all contacts at once
		const contactIds = result.page.map((membership) => membership.contactId);
		const contactsMap = await batchGet(ctx, contactIds);

		const contacts = result.page.map((membership) => {
			const contact = contactsMap.get(membership.contactId);
			// Skip missing or soft-deleted (GDPR-erased) contacts — an erased
			// contact must not re-surface through a topic membership. Redact the
			// DOI capability fields (doiConfirmationToken / doiTokenExpiresAt) so a
			// member-readable read never leaks the /confirm/doi bearer token.
			return contact && contact.deletedAt === undefined
				? {
						...redactContactCapabilityFields(contact),
						addedAt: membership.addedAt,
					}
				: null;
		});

		return {
			page: contacts.filter((c): c is NonNullable<typeof c> => c !== null),
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	},
});

// all-members: the topics panel on the contact detail page every role reads.
// A soft-deleted contact keeps its memberships until the retention sweep, so
// it reads as subscribed to nothing, the way contacts.get reads it as missing.
export const getTopicsForContact = authedQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) =>
		(await getLiveContact(ctx, args.contactId)) ? getTopicsForContactImpl(ctx, args.contactId) : [],
});

// Internal variant for the API-key REST route (no Convex session).
export const getTopicsForContactInternal = internalQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => getTopicsForContactImpl(ctx, args.contactId),
});

// Mutation to update a topic
export const update = authedMutation({
	args: {
		topicId: v.id('topics'),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
		requireDoubleOptIn: v.optional(v.boolean()),
		displayOrder: v.optional(v.number()),
		isDefault: v.optional(v.boolean()),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'topics:manage'),
			'Only owners and admins can manage topics'
		);
		// Validate input lengths
		if (args.name) validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
		if (args.description)
			validateStringLength(args.description, STRING_LIMITS.DESCRIPTION, 'Description');

		await getOrThrow(ctx, args.topicId, 'Topic');

		const updates: {
			name?: string;
			description?: string;
			requireDoubleOptIn?: boolean;
			displayOrder?: number;
			isDefault?: boolean;
			updatedAt: number;
		} = {
			updatedAt: Date.now(),
		};
		if (args.name !== undefined) {
			updates.name = args.name;
		}
		if (args.description !== undefined) {
			updates.description = args.description;
		}
		if (args.requireDoubleOptIn !== undefined) {
			updates.requireDoubleOptIn = args.requireDoubleOptIn;
		}
		if (args.displayOrder !== undefined) {
			updates.displayOrder = args.displayOrder;
		}
		if (args.isDefault !== undefined) {
			updates.isDefault = args.isDefault;
		}

		await ctx.db.patch(args.topicId, updates);
		return args.topicId;
	},
});

// Mutation to delete a topic and all its memberships
export const remove = authedMutation({
	args: { topicId: v.id('topics') },
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'topics:manage'),
			'Only owners and admins can manage topics'
		);
		await getOrThrow(ctx, args.topicId, 'Topic');

		// Delete all memberships associated with this topic
		const memberships = await ctx.db
			.query('contactTopics')
			.withIndex('by_topic', (q) => q.eq('topicId', args.topicId))
			.collect();

		for (const membership of memberships) {
			await ctx.db.delete(membership._id);
		}

		// Delete the topic itself
		await ctx.db.delete(args.topicId);
	},
});

// Mutation to add a contact to a topic.
// Thin auth-bearing shell — the Topic subscription (module) owns every
// write to `contactTopics`, the DOI gate, the trigger fanout, and the
// `cachedMemberCount` patch.

// Public (session-auth) variant. The confirmation-link host is resolved
// server-side from SITE_URL, never accepted from the client — a client host
// would let a `topics:manage` caller aim the token-bearing DOI link at an
// attacker domain (phishing / token exfiltration), exactly like the
// resend path above. The internal REST variant below keeps the explicit
// `siteUrl` because apiHttp.ts already resolves it server-side.
const addContactSessionArgs = {
	topicId: v.id('topics'),
	contactId: v.id('contacts'),
	skipDoi: v.optional(v.boolean()),
};

export const addContact = authedMutation({
	args: addContactSessionArgs,
	handler: async (ctx, args, session): Promise<AddContactResult> => {
		requirePermission(
			hasPermission(session.role, 'topics:manage'),
			'Only owners and admins can manage topic membership'
		);
		return addContactImpl(ctx, { ...args, siteUrl: getOptional('SITE_URL') || '' });
	},
});

// Internal variant for the API-key REST route (no Convex session). The caller
// (topics/apiHttp.ts) resolves `siteUrl` server-side from SITE_URL.
export const addContactInternal = internalMutation({
	args: addContactArgs,
	handler: async (ctx, args): Promise<AddContactResult> => addContactImpl(ctx, args),
});

// Mutation to remove a contact from a topic.
// Thin shell delegating to the Topic subscription (module).
export const removeContact = authedMutation({
	args: removeContactArgs,
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'topics:manage'),
			'Only owners and admins can manage topic membership'
		);
		await removeContactImpl(ctx, args);
	},
});

// Internal variant for the API-key REST route (no Convex session).
export const removeContactInternal = internalMutation({
	args: removeContactArgs,
	handler: async (ctx, args) => {
		await removeContactImpl(ctx, args);
	},
});

// Mutation to confirm contact-level double opt-in via confirmation token.
// Thin wrapper around `doiLifecycle.transitionByConfirmationToken` that maps
// the typed outcome into the customer-facing response envelope.
type ConfirmDoiResult =
	| { success: true; alreadyConfirmed: boolean; contactEmail?: string }
	| { success: false; error: string };

// Internal: the only reachable path is the rate-limited HTTP /confirm/doi route
// (doiHttp.ts), which calls this via internal.*. Keeping it internal (not
// publicMutation) means the DOI confirm can't be invoked directly on the Convex
// client API, bypassing that per-ip+token rate limit. Mirrors the unsubscribe flow.
export const confirmDoi = internalMutation({
	args: {
		token: v.string(),
	},
	handler: async (ctx, args): Promise<ConfirmDoiResult> => {
		// Look up the contact so we can return contactEmail in the response
		// envelope. The lifecycle module performs its own lookup + token-expiry
		// check internally — this read is purely for the response shape.
		const contact = await findContactByConfirmationToken(ctx, args.token);

		// The form rows below are stamped with the contact's confirmation time,
		// which is how a carry still paging finds the token this confirmation
		// consumed (forms/pendingConfirmations.ts).
		const at = Date.now();
		const outcome: DoiTransitionOutcome = await ctx.runMutation(
			internal.contacts.doiLifecycle.transitionByConfirmationToken,
			{
				token: args.token,
				input: { to: 'confirmed', at },
			}
		);

		if (!outcome.ok) {
			// token_not_found and token_expired both surface as the same
			// customer-facing error (consistent with prior behavior).
			return { success: false, error: 'Invalid or expired confirmation token' };
		}

		// The same token may also carry form signups made while the contact was
		// pending; this route confirms them too, as the form-confirm one does.
		await ctx.runMutation(internal.forms.submission.markConfirmedByToken, {
			token: args.token,
			contactId: outcome.contactId,
			at,
		});

		return {
			success: true,
			alreadyConfirmed: outcome.applied === 'recorded',
			contactEmail: contact?.email,
		};
	},
});

// Query to get contact by DOI token (for verification before confirmation).
// Internal — reached only via the rate-limited HTTP /confirm/doi verify route.
export const getContactByDoiToken = internalQuery({
	args: {
		token: v.string(),
	},
	handler: async (ctx, args) => {
		const contact = await findContactByConfirmationToken(ctx, args.token);

		if (!contact || (await isFormTokenDisabled(ctx, args.token))) {
			return null;
		}

		if (contact.doiTokenExpiresAt && contact.doiTokenExpiresAt < Date.now()) {
			return null;
		}

		return {
			contactEmail: contact.email,
			contactFirstName: contact.firstName,
			doiStatus: contact.doiStatus,
		};
	},
});

// Query to get detailed contact information within a topic context
// Returns contact info, membership details, email history from campaigns targeting this topic, and engagement stats
// all-members: the topic member detail page every role reads.
export const getContactInTopicDetails = authedQuery({
	args: {
		topicId: v.id('topics'),
		contactId: v.id('contacts'),
	},
	handler: async (ctx, args) => loadContactInTopicDetails(ctx, args),
});

// Mutation to resend DOI confirmation email for a pending contact.
// Thin wrapper around `doiLifecycle.refreshPendingToken` — the lifecycle
// module owns the new-token write + the email scheduling.
export const resendDoiConfirmation = authedMutation({
	args: {
		contactId: v.id('contacts'),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'topics:manage'),
			'Only owners and admins can resend confirmations'
		);
		// Resolve the confirmation-link host server-side from SITE_URL — never
		// from a client-supplied value. The token-bearing `${siteUrl}/confirm`
		// link is sent from the org's verified MTA, so a client-controlled host
		// would be a phishing / token-exfiltration vector. Mirrors the public
		// add-contact path in topics/apiHttp.ts and the form-DOI path.
		const outcome: DoiRefreshOutcome = await ctx.runMutation(
			internal.contacts.doiLifecycle.refreshPendingToken,
			{
				contactId: args.contactId,
				at: Date.now(),
				token: nanoid(32),
				ttlMs: DOI_TOKEN_TTL_MS,
				siteUrl: getOptional('SITE_URL') || '',
			}
		);
		if (!outcome.ok) {
			if (outcome.reason === 'contact_not_found') {
				return { success: false, error: 'Contact not found' };
			}
			return { success: false, error: 'Contact is not pending confirmation' };
		}
		return { success: true };
	},
});

// ==========================================
// SESSION-BASED QUERIES AND MUTATIONS (US-405)
// These derive auth from the BetterAuth session.
// ==========================================

/**
 * List all topics with cursor-based pagination (session-auth shell).
 * Thin wrapper over the Listing engine.
 */
// all-members: the topic list every role picks audiences from.
export const list = authedQuery({
	args: {
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) =>
		listResources(ctx.db, topicListing, { paginationOpts: args.paginationOpts }),
});

/**
 * Create a new topic.
 */
export const create = authedMutation({
	args: {
		name: v.string(),
		description: v.optional(v.string()),
		requireDoubleOptIn: v.optional(v.boolean()),
		displayOrder: v.optional(v.number()),
		isDefault: v.optional(v.boolean()),
	},
	handler: async (ctx, args, session) => {
		// Validate input lengths
		validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
		if (args.description)
			validateStringLength(args.description, STRING_LIMITS.DESCRIPTION, 'Description');

		requirePermission(
			hasPermission(session.role, 'topics:manage'),
			'Only owners and admins can create topics'
		);

		const topicId = await ctx.db.insert('topics', {
			name: args.name,
			description: args.description,
			requireDoubleOptIn: args.requireDoubleOptIn ?? true,
			displayOrder: args.displayOrder,
			isDefault: args.isDefault,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		await trackEvent(ctx, session, 'topic_created');

		return topicId;
	},
});

/**
 * Reconcile cached member counts for all topics.
 * Processes topics in batches. Called by daily cron.
 */
export const reconcileMemberCounts = internalMutation({
	args: {
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const result = await ctx.db.query('topics').paginate({
			cursor: args.cursor ?? null,
			numItems: 20,
		});

		for (const topic of result.page) {
			const actualCount = await countIndexRange(ctx.db, 'contactTopics', 'by_topic', (q) =>
				q.eq('topicId', topic._id)
			);

			if (topic.cachedMemberCount !== actualCount) {
				await ctx.db.patch(topic._id, {
					cachedMemberCount: actualCount,
					cachedCountUpdatedAt: Date.now(),
				});
			}
		}

		if (!result.isDone) {
			await ctx.scheduler.runAfter(0, internal.topics.topics.reconcileMemberCounts, {
				cursor: result.continueCursor as string,
			});
		}
	},
});
