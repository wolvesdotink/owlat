import { v } from 'convex/values';
import {
	internalQuery,
	internalMutation,
	type MutationCtx,
	type QueryCtx,
} from '../_generated/server';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { paginationOptsValidator } from 'convex/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { nanoid } from 'nanoid';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { countWithPagination } from '../lib/pagination';
import { getOptional } from '../lib/env';
import { listResources } from '../lib/listing';
import { topicListing } from './listing';
import { toPaginationCursor } from '../lib/paginationCursor';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { throwNotFound } from '../_utils/errors';
import { trackEvent } from '../lib/posthogHelpers';
import { batchGet } from '../_utils/batchLoader';
import {
	DOI_TOKEN_TTL_MS,
	findContactByConfirmationToken,
	type TransitionOutcome as DoiTransitionOutcome,
	type RefreshOutcome as DoiRefreshOutcome,
} from '../contacts/doiLifecycle';
import type { SubscribeOutcome } from './subscription';

// Query to get a single topic by ID. Reuses the descriptor's `contactCount`
// enrichment so list and get can no longer drift.
export const get = authedQuery({
	args: { topicId: v.id('topics') },
	handler: async (ctx, args) => {
		const topic = await ctx.db.get(args.topicId);
		if (!topic) return null;

		const enriched = topicListing.enrich ? await topicListing.enrich(ctx.db, topic) : {};
		return { ...topic, ...enriched } as Doc<'topics'> & { contactCount: number };
	},
});

// Internal variant for the API-key REST route (topics/apiHttp.ts), which has
// no Convex session and so cannot call the session-gated `get` above.
export const getInternal = internalQuery({
	args: { topicId: v.id('topics') },
	handler: async (ctx, args) => {
		const topic = await ctx.db.get(args.topicId);
		if (!topic) return null;
		const enriched = topicListing.enrich ? await topicListing.enrich(ctx.db, topic) : {};
		return { ...topic, ...enriched } as Doc<'topics'> & { contactCount: number };
	},
});

// Query to get contacts in a topic (paginated)
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
		const contactsMap = await batchGet<Doc<'contacts'>>(ctx, contactIds);

		const contacts = result.page.map((membership) => {
			const contact = contactsMap.get(String(membership.contactId));
			return contact
				? {
						...contact,
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

// Query to get topics for a specific contact
async function getTopicsForContactImpl(ctx: QueryCtx, contactId: Id<'contacts'>) {
	const memberships = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's topic memberships

	// Batch-load all topics at once
	const topicIds = memberships.map((membership) => membership.topicId);
	const topicsMap = await batchGet<Doc<'topics'>>(ctx, topicIds);

	const topics = memberships.map((membership) => {
		const topic = topicsMap.get(String(membership.topicId));
		return topic
			? {
					...topic,
					addedAt: membership.addedAt,
				}
			: null;
	});

	// Filter out null values (topics that may have been deleted)
	return topics.filter((l): l is NonNullable<typeof l> => l !== null);
}

export const getTopicsForContact = authedQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => getTopicsForContactImpl(ctx, args.contactId),
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
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'topics:manage', 'Only owners and admins can manage topics');
		// Validate input lengths
		if (args.name) validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
		if (args.description)
			validateStringLength(args.description, STRING_LIMITS.DESCRIPTION, 'Description');

		const topic = await ctx.db.get(args.topicId);
		if (!topic) {
			throwNotFound('Topic');
		}

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
// Batch size for cascading a topic's membership deletion. Small enough to keep
// each mutation well under Convex's per-transaction document limit.
const TOPIC_CASCADE_BATCH = 200;

// Delete one batch of a topic's memberships. Returns true once the topic has no
// remaining memberships (the caller may then delete the topic itself).
async function drainTopicMemberships(ctx: MutationCtx, topicId: Id<'topics'>): Promise<boolean> {
	const batch = await ctx.db
		.query('contactTopics')
		.withIndex('by_topic', (q) => q.eq('topicId', topicId))
		.take(TOPIC_CASCADE_BATCH);
	for (const membership of batch) {
		await ctx.db.delete(membership._id);
	}
	return batch.length < TOPIC_CASCADE_BATCH;
}

export const remove = authedMutation({
	args: { topicId: v.id('topics') },
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'topics:manage', 'Only owners and admins can manage topics');
		const topic = await ctx.db.get(args.topicId);
		if (!topic) {
			throwNotFound('Topic');
		}

		// Drain the topic's memberships first so the topic never outlives a dangling
		// membership. A small topic finishes inline; a large one hands off to a
		// self-rescheduling internal mutation that deletes the topic once drained.
		const drained = await drainTopicMemberships(ctx, args.topicId);
		if (drained) {
			await ctx.db.delete(args.topicId);
		} else {
			await ctx.scheduler.runAfter(0, internal.topics.topics.finishRemoveTopic, {
				topicId: args.topicId,
			});
		}
	},
});

// Continuation of `remove` for topics with more memberships than one batch:
// drain another batch, reschedule until empty, then delete the topic itself.
export const finishRemoveTopic = internalMutation({
	args: { topicId: v.id('topics') },
	handler: async (ctx, args) => {
		const drained = await drainTopicMemberships(ctx, args.topicId);
		if (!drained) {
			await ctx.scheduler.runAfter(0, internal.topics.topics.finishRemoveTopic, args);
			return;
		}
		// Memberships gone — remove the topic (guarding against a concurrent delete).
		const topic = await ctx.db.get(args.topicId);
		if (topic) {
			await ctx.db.delete(args.topicId);
		}
	},
});

// Mutation to add a contact to a topic.
// Thin auth-bearing shell — the Topic subscription (module) owns every
// write to `contactTopics`, the DOI gate, the trigger fanout, and the
// `cachedMemberCount` patch. See docs/adr/0013-topic-subscription-module.md.
type AddContactResult = {
	membershipId: Id<'contactTopics'>;
	doiStatus: 'not_required' | 'pending' | 'confirmed';
};

const addContactArgs = {
	topicId: v.id('topics'),
	contactId: v.id('contacts'),
	// Optional: skip DOI for this specific addition (admin-authoritative).
	skipDoi: v.optional(v.boolean()),
	// Optional: site URL for confirmation email.
	siteUrl: v.optional(v.string()),
};

async function addContactImpl(
	ctx: MutationCtx,
	args: { topicId: Id<'topics'>; contactId: Id<'contacts'>; skipDoi?: boolean; siteUrl?: string }
): Promise<AddContactResult> {
	const outcome: SubscribeOutcome = await ctx.runMutation(internal.topics.subscription.subscribe, {
		topicId: args.topicId,
		contactId: args.contactId,
		source: 'public_api',
		...(args.skipDoi === true ? { skipDoi: true } : {}),
		...(args.siteUrl ? { siteUrl: args.siteUrl } : {}),
	});

	if (!outcome.ok) {
		// `throwNotFound` is typed `never` — single tail call gives TS
		// the narrowing it needs to keep `outcome.ok === true` below.
		throwNotFound(outcome.reason === 'topic_not_found' ? 'Topic' : 'Contact');
	}

	// Preserve the legacy `{ membershipId, doiStatus }` return shape.
	// The form-confirmation path branches on `doiStatus === 'pending'` to
	// decide whether to record the submission as `pending_confirmation`,
	// so the `pending_doi` outcome MUST surface as 'pending' here.
	let doiStatus: 'not_required' | 'pending' | 'confirmed';
	if (outcome.action === 'pending_doi') {
		doiStatus = 'pending';
	} else {
		// 'subscribed' or 'already_member' — read the contact's current
		// doiStatus. Matches the pre-deepening behavior (returned the
		// contact's actual status when already a member; returned
		// 'not_required' or 'confirmed' depending on contact state when
		// subscribing without DOI request).
		const contact = await ctx.db.get(args.contactId);
		doiStatus = contact?.doiStatus ?? 'not_required';
	}

	return { membershipId: outcome.membershipId, doiStatus };
}

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
	handler: async (ctx, args): Promise<AddContactResult> => {
		await requireOrgPermission(
			ctx,
			'topics:manage',
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
const removeContactArgs = {
	topicId: v.id('topics'),
	contactId: v.id('contacts'),
};

async function removeContactImpl(
	ctx: MutationCtx,
	args: { topicId: Id<'topics'>; contactId: Id<'contacts'> }
): Promise<void> {
	await ctx.runMutation(internal.topics.subscription.unsubscribe, {
		topicId: args.topicId,
		contactId: args.contactId,
		source: 'admin',
	});
}

export const removeContact = authedMutation({
	args: removeContactArgs,
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'topics:manage',
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

		const outcome: DoiTransitionOutcome = await ctx.runMutation(
			internal.contacts.doiLifecycle.transitionByConfirmationToken,
			{
				token: args.token,
				input: { to: 'confirmed', at: Date.now() },
			}
		);

		if (!outcome.ok) {
			// token_not_found and token_expired both surface as the same
			// customer-facing error (consistent with prior behavior).
			return { success: false, error: 'Invalid or expired confirmation token' };
		}

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

		if (!contact) {
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
export const getContactInTopicDetails = authedQuery({
	args: {
		topicId: v.id('topics'),
		contactId: v.id('contacts'),
	},
	handler: async (ctx, args) => {
		// Fetch the topic
		const topic = await ctx.db.get(args.topicId);
		if (!topic) {
			return null;
		}

		// Fetch the contact
		const contact = await ctx.db.get(args.contactId);
		if (!contact) {
			return null;
		}

		// Fetch the membership
		const membership = await ctx.db
			.query('contactTopics')
			.withIndex('by_contact_and_topic', (q) =>
				q.eq('contactId', args.contactId).eq('topicId', args.topicId)
			)
			.first();

		if (!membership) {
			return null;
		}

		// Fetch campaigns that target this specific topic. The audience is a
		// discriminated value (ADR-0033) whose topic id lives inside the union,
		// so filter in JS after a bounded scan.
		const scanned = await ctx.db.query('campaigns').take(1000); // bounded: topic-detail lookup
		const campaigns = scanned.filter(
			(c) => c.audience?.kind === 'topic' && c.audience.topicId === args.topicId
		);

		// Limit to most recent campaigns for email history lookup
		const topicCampaigns = campaigns.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);

		// Get email sends for this contact from these campaigns
		const emailHistory = await Promise.all(
			topicCampaigns.map(async (campaign) => {
				const emailSend = await ctx.db
					.query('emailSends')
					.withIndex('by_campaign_and_contact', (q) =>
						q.eq('campaignId', campaign._id).eq('contactId', args.contactId)
					)
					.first();

				if (!emailSend) return null;

				return {
					campaignId: campaign._id,
					campaignName: campaign.name,
					subject: campaign.subject || '',
					status: emailSend.status,
					sentAt: emailSend.sentAt,
					openedAt: emailSend.openedAt,
					clickedAt: emailSend.clickedAt,
					openCount: emailSend.openCount || 0,
					clickedLinks: emailSend.clickedLinks || [],
				};
			})
		);

		// Filter out null entries and sort by sentAt descending
		const validEmailHistory = emailHistory
			.filter((e): e is NonNullable<typeof e> => e !== null)
			.sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));

		// Calculate aggregate stats
		const totalSent = validEmailHistory.length;
		const totalOpened = validEmailHistory.filter((e) => e.openedAt).length;
		const totalClicked = validEmailHistory.filter((e) => e.clickedAt).length;

		// Find last engagement date (most recent open or click)
		const engagementDates = validEmailHistory
			.flatMap((e) => [e.openedAt, e.clickedAt].filter((d): d is number => d !== undefined))
			.sort((a, b) => b - a);
		const lastEngagement = engagementDates[0] || null;

		return {
			topic: {
				_id: topic._id,
				name: topic.name,
				description: topic.description,
				requireDoubleOptIn: topic.requireDoubleOptIn,
				createdAt: topic.createdAt,
			},
			contact: {
				_id: contact._id,
				email: contact.email,
				firstName: contact.firstName,
				lastName: contact.lastName,
				createdAt: contact.createdAt,
			},
			membership: {
				addedAt: membership.addedAt,
			},
			emailHistory: validEmailHistory,
			emailStats: {
				totalSent,
				totalOpened,
				totalClicked,
				openRate: totalSent > 0 ? Math.round((totalOpened / totalSent) * 100) : 0,
				clickRate: totalSent > 0 ? Math.round((totalClicked / totalSent) * 100) : 0,
				lastEngagement,
			},
		};
	},
});

// Mutation to resend DOI confirmation email for a pending contact.
// Thin wrapper around `doiLifecycle.refreshPendingToken` — the lifecycle
// module owns the new-token write + the email scheduling.
export const resendDoiConfirmation = authedMutation({
	args: {
		contactId: v.id('contacts'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'topics:manage',
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
 * Thin wrapper over the Listing engine — see ADR-0037.
 */
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
	handler: async (ctx, args) => {
		// Validate input lengths
		validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
		if (args.description)
			validateStringLength(args.description, STRING_LIMITS.DESCRIPTION, 'Description');

		const session = await requireOrgPermission(
			ctx,
			'topics:manage',
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
 * Reorder topics by setting displayOrder values.
 */
export const reorder = authedMutation({
	args: {
		topicIds: v.array(v.id('topics')),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'topics:manage', 'Only owners and admins can reorder topics');

		for (let i = 0; i < args.topicIds.length; i++) {
			const topicId = args.topicIds[i]!;
			const topic = await ctx.db.get(topicId);
			if (!topic) continue;
			await ctx.db.patch(topicId, {
				displayOrder: i,
				updatedAt: Date.now(),
			});
		}
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
			cursor: toPaginationCursor(args.cursor),
			numItems: 20,
		});

		for (const topic of result.page) {
			const actualCount = await countWithPagination(ctx.db, 'contactTopics', 'by_topic', (q) =>
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
