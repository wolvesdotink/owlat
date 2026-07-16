import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { authedQuery, authedMutation, publicMutation } from '../lib/authedFunctions';
import { components, internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { BULK_QUERY_LIMIT } from '../lib/constants';
import { randomToken } from '../lib/randomToken';
import { getOptional } from '../lib/env';
import {
	requireOrgPermission,
	requireSelf,
	loadOwnUserProfile,
	hasPermission,
} from '../lib/sessionOrganization';
import type { OrganizationRole } from '../lib/sessionOrganization';
import { throwNotFound, throwInvalidState } from '../_utils/errors';

// Type for organization data export
interface OrganizationExport {
	organization: { _id: string; name: string; slug?: string | null };
	role: string;
	data: {
		contacts: Doc<'contacts'>[];
		contactProperties: Doc<'contactProperties'>[];
		topics: Doc<'topics'>[];
		emailTemplates: Doc<'emailTemplates'>[];
		campaigns: Doc<'campaigns'>[];
		automations: Doc<'automations'>[];
		transactionalEmails: Doc<'transactionalEmails'>[];
		segments: Doc<'segments'>[];
		apiKeys: { name: string; keyPrefix: string; createdAt: number; lastUsedAt?: number }[];
		webhooks: Omit<Doc<'webhooks'>, 'secret'>[];
		domains: Doc<'domains'>[];
		formEndpoints: Doc<'formEndpoints'>[];
		blockedEmails: Doc<'blockedEmails'>[];
	};
}

// The requesting user's OWN personal data — the exact records the right-to-
// erasure walk (auth/memberErasure.ts) deletes, so right-to-access mirrors
// right-to-erasure. Credential/secret material is redacted: the encrypted
// external-account envelope (secretCiphertext/iv/authTag) and storage-blob
// handles (rawStorageId etc.) are stripped, just like webhook secrets above.
interface PersonalDataExport {
	mailboxes: Doc<'mailboxes'>[];
	mailMessages: Omit<
		Doc<'mailMessages'>,
		'rawStorageId' | 'textBodyStorageId' | 'htmlBodyStorageId'
	>[];
	mailDrafts: Doc<'mailDrafts'>[];
	externalMailAccounts: Omit<
		Doc<'externalMailAccounts'>,
		'secretCiphertext' | 'secretIv' | 'secretAuthTag'
	>[];
	chatMessages: Doc<'chatMessages'>[];
}

/**
 * Get all data for a user (for GDPR data export)
 * Returns all teams the user belongs to and all data within those teams
 */
export const exportUserData = authedQuery({
	args: {
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);

		// Get user profile by authUserId
		const userProfile = await loadOwnUserProfile(ctx, args.userId);
		if (!userProfile) {
			throwNotFound('User profile');
		}

		// Get all organization memberships from BetterAuth's member table
		// Need to use authUserId to query BetterAuth
		const membershipResult = await ctx.runQuery(components.betterAuth.adapter.findMany, {
			model: 'member',
			where: [{ field: 'userId', value: userProfile.authUserId }],
			paginationOpts: { cursor: null, numItems: BULK_QUERY_LIMIT },
		});
		const organizationMemberships = (membershipResult?.page ?? []) as Array<{
			_id: string;
			organizationId: string;
			userId: string;
			role: string;
		}>;

		// Get all organizations the user belongs to
		const organizations: OrganizationExport[] = [];

		for (const membership of organizationMemberships) {
			const organizationId = membership.organizationId;
			// Query organization from BetterAuth's organization table
			const organization = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
				model: 'organization',
				where: [{ field: '_id', value: organizationId }],
			})) as { _id: string; name: string; slug?: string | null } | null;
			if (!organization) continue;

			// Fetch all data.
			// Each scan is intentionally unbounded: this is a user-initiated GDPR-style
			// export that must include every record. Large deployments hit Convex
			// runtime limits and fail loudly — migrating to a streamed/paginated
			// action is tracked but out of scope for the lint-baseline pass.
			// Exclude soft-deleted (GDPR-erased) contacts from the export — ride
			// the soft-delete browse index so erased rows never re-surface.
			const contacts = await ctx.db
				.query('contacts')
				.withIndex('by_deleted_at_and_created_at', (q) => q.eq('deletedAt', undefined))
				.collect(); // bounded: account-export
			const contactProperties = await ctx.db.query('contactProperties').collect(); // bounded: account-export
			const topics = await ctx.db.query('topics').collect(); // bounded: account-export
			const emailTemplates = await ctx.db.query('emailTemplates').collect(); // bounded: account-export
			const campaigns = await ctx.db.query('campaigns').collect(); // bounded: account-export
			const automations = await ctx.db.query('automations').collect(); // bounded: account-export
			const transactionalEmails = await ctx.db.query('transactionalEmails').collect(); // bounded: account-export
			const segments = await ctx.db.query('segments').collect(); // bounded: account-export

			// API-key and webhook metadata are admin-only org configuration (the
			// dedicated queries are adminQuery-gated). A GDPR self-export is about
			// the requesting *user's* personal data — only surface this org-admin
			// metadata when the caller is themselves an admin/owner of this org,
			// so a plain member's self-export can't enumerate key prefixes or
			// webhook endpoints. Secrets/hashes are never included regardless.
			const isOrgAdmin = hasPermission(membership.role as OrganizationRole, 'organization:manage');

			// For API keys, only return non-sensitive info (no hash)
			const rawApiKeys = isOrgAdmin
				? await ctx.db.query('apiKeys').collect() // bounded: account-export
				: [];
			const apiKeys = rawApiKeys.map((key) => ({
				name: key.name,
				keyPrefix: key.keyPrefix,
				createdAt: key.createdAt,
				lastUsedAt: key.lastUsedAt,
			}));

			const rawWebhooks = isOrgAdmin
				? await ctx.db.query('webhooks').collect() // bounded: account-export
				: [];
			// Redact webhook signing secrets from export data
			const webhooks = rawWebhooks.map(({ secret: _secret, ...webhook }) => webhook);

			const domains = await ctx.db.query('domains').collect(); // bounded: account-export
			const formEndpoints = await ctx.db.query('formEndpoints').collect(); // bounded: account-export
			const blockedEmails = await ctx.db.query('blockedEmails').collect(); // bounded: account-export

			organizations.push({
				organization,
				role: membership.role,
				data: {
					contacts,
					contactProperties,
					topics,
					emailTemplates,
					campaigns,
					automations,
					transactionalEmails,
					segments,
					apiKeys,
					webhooks,
					domains,
					formEndpoints,
					blockedEmails,
				},
			});
		}

		// ── The requesting user's OWN personal data ──
		// The org sections above are tenant data identical for every member; for
		// a plain editor it isn't even "their" data. Right-to-access must also
		// hand the user the personal data the erasure walk would delete: their
		// mailbox(es), mail, drafts, external account connections, and chat
		// authorship. Each read is keyed by `authUserId` (the same indexes
		// auth/memberErasure.ts walks). Secrets/blob handles are redacted.
		const personalData = await collectPersonalData(ctx, userProfile.authUserId);

		return {
			userProfile: {
				email: userProfile.email,
				name: userProfile.name,
				image: userProfile.image,
				createdAt: userProfile.createdAt,
				updatedAt: userProfile.updatedAt,
			},
			organizations,
			personalData,
			exportedAt: Date.now(),
		};
	},
});

/**
 * Collect the requesting user's own personal data for the GDPR access export —
 * the mirror of the right-to-erasure walk in auth/memberErasure.ts. Reads are
 * keyed by BetterAuth `authUserId` and intentionally unbounded per the same
 * "user-initiated export must include every record; large deployments fail
 * loudly" rationale as the org sections (these are per-user, far smaller).
 * Credential ciphertext and raw storage-blob handles are stripped.
 */
async function collectPersonalData(ctx: QueryCtx, authUserId: string): Promise<PersonalDataExport> {
	// A `scope='shared'` team inbox is org infrastructure the user merely
	// custodies (`userId`), not their personal data — exclude it (and all its team
	// mail) from the personal-data export, mirroring the erasure walk that now
	// preserves it. Only genuinely personal mailboxes belong in this export.
	const mailboxes = (
		await ctx.db
			.query('mailboxes')
			.withIndex('by_user', (q) => q.eq('userId', authUserId))
			.collect()
	) // bounded: account-export, one user's own mailboxes (+ any team inboxes they created)
		.filter((m) => m.scope !== 'shared');

	const mailMessages: PersonalDataExport['mailMessages'] = [];
	const mailDrafts: Doc<'mailDrafts'>[] = [];
	for (const mailbox of mailboxes) {
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailbox._id))
			.collect(); // bounded: account-export, one mailbox's messages
		for (const msg of messages) {
			// Strip storage-blob handles (internal references, not personal data).
			const {
				rawStorageId: _raw,
				textBodyStorageId: _text,
				htmlBodyStorageId: _html,
				...rest
			} = msg;
			mailMessages.push(rest);
		}

		const drafts = await ctx.db
			.query('mailDrafts')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
			.collect(); // bounded: account-export, one mailbox's drafts
		mailDrafts.push(...drafts);
	}

	const rawExternalAccounts = (
		await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', authUserId))
			.collect()
	) // bounded: account-export, a user connects a handful of accounts
		.filter((a) => a.scope !== 'shared'); // shared = the org's team-inbox credentials, not personal data
	// Redact the encrypted credential envelope (same posture as webhook secrets).
	const externalMailAccounts = rawExternalAccounts.map(
		({ secretCiphertext: _ct, secretIv: _iv, secretAuthTag: _tag, ...account }) => account
	);

	const chatMessages = await ctx.db
		.query('chatMessages')
		.withIndex('by_author', (q) => q.eq('authorId', authUserId))
		.collect(); // bounded: account-export, messages this user authored

	return { mailboxes, mailMessages, mailDrafts, externalMailAccounts, chatMessages };
}

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
			// Find by token (from email link)
			const token = args.cancellationToken;
			request = await ctx.db
				.query('accountDeletionRequests')
				.withIndex('by_cancellation_token', (q) => q.eq('cancellationToken', token))
				.filter((q) => q.eq(q.field('status'), 'pending'))
				.first();
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

		// Update the request status
		await ctx.db.patch(request._id, {
			status: 'cancelled',
			statusChangedAt: Date.now(),
		});

		return { success: true };
	},
});

/**
 * Execute one account deletion in full: the org's tenant data (when the user
 * owns the org), the BetterAuth organization + memberships, onboarding
 * progress, the user profile, and finally marking the deletion request
 * `completed`. Shared by the daily `processPendingDeletions` cron in
 * `auth/accountDeletion.ts`.
 *
 * The caller is responsible for confirming the request is `pending` and past
 * its grace period before calling this.
 */
export async function deleteAccountForRequest(
	ctx: MutationCtx,
	request: Doc<'accountDeletionRequests'>
): Promise<void> {
	const now = Date.now();

	// Get user profile to get authUserId for BetterAuth queries
	const userProfile = await ctx.db.get(request.userProfileId);
	if (!userProfile) {
		// Profile already gone — just close out the request.
		await ctx.db.patch(request._id, { status: 'completed', statusChangedAt: now });
		return;
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
	let isOwner = false;
	for (const membership of memberships) {
		const organizationId = membership.organizationId;

		// If the user owns the org, the entire tenant dataset goes — via the
		// BATCHED organization-deletion walker. The previous implementation
		// collected every row of every tenant table inside this one mutation,
		// which exceeds transaction limits on any realistic deployment (the
		// cron then failed forever) and never purged storage blobs; the walker
		// is batched, storage-aware, and covers all of TENANT_TABLES.
		if (membership.role === 'owner') {
			isOwner = true;
			await ctx.scheduler.runAfter(0, internal.workspaces.deletion.walker.start, {});

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

	// Delete the user profile
	await ctx.db.delete(request.userProfileId);

	if (isOwner) {
		// The org walker is draining the whole tenant dataset in the background;
		// the auth-side rows above are already gone, so the request is done.
		await ctx.db.patch(request._id, { status: 'completed', statusChangedAt: now });
	} else {
		// Non-owner members own personal data the org keeps running without:
		// their mailbox + mail (and blobs), external account credentials, chat
		// authorship. A batched background job erases it and marks the request
		// completed when it finishes (previously this data silently survived).
		await ctx.scheduler.runAfter(0, internal.auth.memberErasure.eraseMemberData, {
			authUserId: userProfile.authUserId,
			requestId: request._id,
		});
	}
}
