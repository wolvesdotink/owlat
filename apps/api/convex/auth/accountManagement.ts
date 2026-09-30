import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { authedQuery, authedMutation, publicMutation } from '../lib/authedFunctions';
import { components, internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { BULK_QUERY_LIMIT } from '../lib/constants';
import { randomToken } from '../lib/randomToken';
import { getOptional } from '../lib/env';
import { requireOrgPermission, requireSelf, loadOwnUserProfile } from '../lib/sessionOrganization';
import { throwNotFound, throwInvalidState } from '../_utils/errors';
import { beginWorkspaceDeletion } from '../workspaces/deletion/job';
import { beginMemberErasure, resumeRequestWithoutProfile } from './erasure/lifecycle';

/**
 * Get contacts export data with property values (CSV format).
 *
 * User-initiated export. Intentionally unbounded; large deployments will hit
 * Convex runtime limits and fail. Migrating to a streamed/paginated CSV
 * action is tracked separately.
 */
export const exportContactsForOrganization = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can export contacts'
		);
		// Get all live contacts — soft-deleted (GDPR-erased) contacts must never
		// re-surface in a CSV export; ride the soft-delete browse index.
		const contacts = await ctx.db
			.query('contacts')
			.withIndex('by_deleted_at_and_created_at', (q) => q.eq('deletedAt', undefined))
			.collect(); // bounded: csv-export

		// Get all contact properties
		const properties = await ctx.db.query('contactProperties').collect(); // bounded: csv-export

		// Get all property values for all contacts
		const contactIds = contacts.map((c) => c._id);
		const allPropertyValues: Record<string, Record<string, string>> = {};

		for (const contactId of contactIds) {
			const values = await ctx.db
				.query('contactPropertyValues')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect(); // bounded: csv-export, per-contact lookup via indexed query

			allPropertyValues[contactId] = {};
			for (const value of values) {
				allPropertyValues[contactId][value.propertyId] = value.value;
			}
		}

		// Get topic memberships
		const topics = await ctx.db.query('topics').collect(); // bounded: csv-export

		const listMemberships: Record<string, string[]> = {};
		for (const list of topics) {
			const memberships = await ctx.db
				.query('contactTopics')
				.withIndex('by_topic', (q) => q.eq('topicId', list._id))
				.collect(); // bounded: csv-export, per-topic lookup via indexed query

			for (const membership of memberships) {
				if (!listMemberships[membership.contactId]) {
					listMemberships[membership.contactId] = [];
				}
				const memberLists = listMemberships[membership.contactId];
				if (memberLists) {
					memberLists.push(list.name);
				}
			}
		}

		return {
			contacts: contacts.map((contact) => ({
				email: contact.email,
				firstName: contact.firstName || '',
				lastName: contact.lastName || '',
				source: contact.source,
				timezone: contact.timezone || '',
				createdAt: new Date(contact.createdAt).toISOString(),
				updatedAt: new Date(contact.updatedAt).toISOString(),
				topics: (listMemberships[contact._id] || []).join('; '),
				...Object.fromEntries(
					properties.map((prop) => [prop.key, allPropertyValues[contact._id]?.[prop._id] || ''])
				),
			})),
			properties: properties.map((p) => p.key),
		};
	},
});

/**
 * Get pending deletion request for a user
 */
export const getPendingDeletionRequest = authedQuery({
	args: {
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);

		// Get user profile by authUserId
		const userProfile = await loadOwnUserProfile(ctx, args.userId);
		if (!userProfile) {
			return null;
		}

		const request = await ctx.db
			.query('accountDeletionRequests')
			.withIndex('by_user_profile', (q) => q.eq('userProfileId', userProfile._id))
			.filter((q) => q.eq(q.field('status'), 'pending'))
			.first();

		return request;
	},
});

/**
 * Request account deletion with 30-day grace period
 */
// authz: self — args.userId must equal the caller (checked below).
export const requestAccountDeletion = authedMutation({
	args: {
		userId: v.string(),
		reason: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);

		// Get user profile by authUserId
		const userProfile = await loadOwnUserProfile(ctx, args.userId);
		if (!userProfile) {
			throwNotFound('User profile');
		}

		// Check for existing pending request
		const existingRequest = await ctx.db
			.query('accountDeletionRequests')
			.withIndex('by_user_profile', (q) => q.eq('userProfileId', userProfile._id))
			.filter((q) => q.eq(q.field('status'), 'pending'))
			.first();

		if (existingRequest) {
			throwInvalidState('A deletion request is already pending for this account');
		}

		const now = Date.now();
		const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;

		// Generate a secure cancellation token
		const cancellationToken = randomToken(64);

		// Create the deletion request
		const requestId = await ctx.db.insert('accountDeletionRequests', {
			userProfileId: userProfile._id,
			email: userProfile.email,
			requestedAt: now,
			scheduledForDeletion: now + thirtyDaysInMs,
			cancellationToken,
			status: 'pending',
			reason: args.reason,
			createdAt: now,
		});

		// Send the confirmation email carrying the cancel-deletion link. The
		// in-app banner is the primary cancel path, so this is best-effort
		// (scheduled, not awaited inline).
		const siteUrl = getOptional('SITE_URL') || 'http://localhost:3000';
		await ctx.scheduler.runAfter(0, internal.accountDeletionEmail.sendAccountDeletionEmail, {
			email: userProfile.email,
			scheduledForDeletion: now + thirtyDaysInMs,
			cancellationToken,
			siteUrl,
			// The mail warns about something irreversible, so it goes out in the
			// language this person set the product to. Absent = English.
			locale: userProfile.locale,
		});

		return {
			requestId,
			scheduledForDeletion: now + thirtyDaysInMs,
			cancellationToken,
		};
	},
});

/**
 * Cancel a pending account deletion request.
 *
 * Intentionally public: the primary path is an email "cancel deletion" link
 * that carries a secret `cancellationToken` and is followed while logged out.
 * The session path (no token, from the settings page) still enforces
 * `args.userId === sessionUserId` ownership below, and the token path requires
 * possession of the unguessable per-request token.
 */
// public: email-link cancellation via secret token; session path is ownership-checked inside
export const cancelAccountDeletion = publicMutation({
	args: {
		userId: v.string(),
		cancellationToken: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		// Find the pending request
		let request;

		if (args.cancellationToken) {
			// Find by token (from email link). Looked up in any state, so a link
			// followed after the erasure began is told so rather than "not found".
			const token = args.cancellationToken;
			request = await ctx.db
				.query('accountDeletionRequests')
				.withIndex('by_cancellation_token', (q) => q.eq('cancellationToken', token))
				.first();
			if (request && request.status !== 'pending') {
				refuseCancellationOf(request);
			}
		} else {
			await requireSelf(ctx, args.userId);

			// Find by user profile (from settings page) - need to lookup userProfile first
			const userProfile = await loadOwnUserProfile(ctx, args.userId);
			if (!userProfile) {
				throwNotFound('User profile');
			}
			request = await ctx.db
				.query('accountDeletionRequests')
				.withIndex('by_user_profile', (q) => q.eq('userProfileId', userProfile._id))
				.filter((q) => q.eq(q.field('status'), 'pending'))
				.first();
		}

		if (!request) {
			throwNotFound('Pending deletion request');
		}

		// Only a `pending` request reaches this point, in this transaction: the
		// deletion cron moves a request to `erasing` in the same transaction that
		// starts destroying data, so the two cannot interleave.
		await ctx.db.patch(request._id, {
			status: 'cancelled',
			statusChangedAt: Date.now(),
		});

		return { success: true };
	},
});

/**
 * A request that is no longer `pending` cannot be cancelled: from `erasing` on,
 * data is already gone. Says which state it is in instead of "not found".
 */
function refuseCancellationOf(request: Doc<'accountDeletionRequests'>): never {
	if (request.status === 'cancelled')
		throwInvalidState('This deletion request was already cancelled');
	throwInvalidState('The account deletion has already started and can no longer be cancelled', {
		reason: 'account_deletion_started',
		status: request.status,
	});
}

/**
 * Start one account deletion: the org's tenant data (when the user owns the
 * org), the BetterAuth organization + memberships, onboarding progress and the
 * user profile go here; the persisted member erasure (auth/erasure/) removes
 * the login identity and the member's personal data and marks the request
 * `completed` once it has verified the result. Shared by the daily
 * `processPendingDeletions` cron in `auth/accountDeletion.ts`.
 *
 * The caller is responsible for confirming the request is `pending` and past
 * its grace period before calling this.
 */
export async function deleteAccountForRequest(
	ctx: MutationCtx,
	request: Doc<'accountDeletionRequests'>
): Promise<'started' | 'resumed' | 'failed'> {
	// Get user profile to get authUserId for BetterAuth queries
	const userProfile = await ctx.db.get(request.userProfileId);
	if (!userProfile) {
		// A missing profile is NOT proof of completion: before erasures were
		// persisted, the profile went first and the rest of the erasure lived
		// only in a scheduled chain that may have died.
		return await resumeRequestWithoutProfile(ctx, request);
	}

	// Get all organization memberships from BetterAuth's member table
	const membershipResult = await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'member',
		where: [{ field: 'userId', value: userProfile.authUserId }],
		paginationOpts: { cursor: null, numItems: BULK_QUERY_LIMIT },
	});
	const memberships = (membershipResult?.page ?? []) as Array<{
		_id: string;
		organizationId: string;
		userId: string;
		role: string;
	}>;

	// For each organization, delete user-specific data
	for (const membership of memberships) {
		const organizationId = membership.organizationId;

		// If the user owns the org, the entire tenant dataset goes — via the
		// BATCHED organization-deletion walker. The previous implementation
		// collected every row of every tenant table inside this one mutation,
		// which exceeds transaction limits on any realistic deployment (the
		// cron then failed forever) and never purged storage blobs; the walker
		// is batched, storage-aware, and covers all of TENANT_TABLES.
		if (membership.role === 'owner') {
			// Opened in this transaction, so the write fence is up before the
			// BetterAuth rows below go. Those rows are not part of the sweep: the
			// organization and this owner's membership leave here, once, before
			// any tenant table is touched.
			await beginWorkspaceDeletion(ctx, {
				source: 'account_deletion',
				requestedBy: userProfile.authUserId,
			});

			// Delete the organization itself from BetterAuth's organization table
			await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
				input: {
					model: 'organization',
					where: [{ field: '_id', value: organizationId }],
				},
			});
		}

		// Delete the membership from BetterAuth's member table
		await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
			input: {
				model: 'member',
				where: [
					{ field: 'organizationId', value: membership.organizationId },
					{ field: 'userId', value: userProfile.authUserId },
				],
			},
		});
	}

	// Delete onboarding progress (keyed by BetterAuth userId, not userProfileId)
	const onboardingRecords = await ctx.db
		.query('onboardingProgress')
		.withIndex('by_user', (q) => q.eq('userId', userProfile.authUserId))
		.collect(); // bounded: one user's onboarding row (≈1)
	for (const record of onboardingRecords) {
		await ctx.db.delete(record._id);
	}

	// Persist the subject and start the erasure BEFORE the profile that names it
	// goes (same transaction): the request becomes `erasing` and can no longer
	// be cancelled, the login identity is removed so every session stops
	// resolving, and the job's first step is scheduled. The job erases the
	// member's personal data (for an owner it waits for the workspace sweep to
	// finish) and only then marks the request `completed`.
	await beginMemberErasure(ctx, request._id, {
		authUserId: userProfile.authUserId,
		email: userProfile.email,
	});

	// Delete the user profile
	await ctx.db.delete(request.userProfileId);
	return 'started';
}
