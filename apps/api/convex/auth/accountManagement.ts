import { v } from 'convex/values';
import {
	ACCOUNT_EXPORT_ORGANIZATION_RESOURCES,
	ACCOUNT_EXPORT_PERSONAL_RESOURCES,
	isAccountExportOrganizationResource,
	serializeAccountExportPage,
	type AccountExportManifest,
	type SerializedAccountExportPage,
} from '@owlat/shared';
import type { PaginationResult } from 'convex/server';
import type { ActionCtx, MutationCtx } from '../_generated/server';
import { authedAction, authedQuery, authedMutation, publicMutation } from '../lib/authedFunctions';
import { components, internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { BULK_QUERY_LIMIT } from '../lib/constants';
import { randomToken } from '../lib/randomToken';
import { getOptional } from '../lib/env';
import { requireOrgPermission, requireSelf, loadOwnUserProfile } from '../lib/sessionOrganization';
import { throwNotFound, throwInvalidState } from '../_utils/errors';
import {
	openMailDraftForAccountExport,
	readMailMessageBodiesForAccountExport,
} from '../lib/messageBodyExport';
import { sealedBlobUrl, storeSealedBlob } from '../lib/sealedBlob';

const ACCOUNT_EXPORT_PAGE_SIZE = 100;
const ACCOUNT_EXPORT_BODY_PAGE_SIZE = 1;
const ACCOUNT_EXPORT_CONTENT_TTL_MS = 60 * 60 * 1_000;
const accountExportResourceValidator = v.union(
	v.literal('organizationMemberships'),
	...ACCOUNT_EXPORT_ORGANIZATION_RESOURCES.map((resource) => v.literal(resource)),
	...ACCOUNT_EXPORT_PERSONAL_RESOURCES.map((resource) => v.literal(resource))
);

async function stageAccountExportContent(
	ctx: ActionCtx,
	content: Record<string, unknown>
): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(content));
	const storageId = await storeSealedBlob(ctx.storage, bytes, 'application/json');
	try {
		await ctx.scheduler.runAt(
			Date.now() + ACCOUNT_EXPORT_CONTENT_TTL_MS,
			internal.auth.accountExport.deleteStagedContent,
			{ storageId }
		);
	} catch (error) {
		await ctx.storage.delete(storageId);
		throw error;
	}
	const url = await sealedBlobUrl(ctx.storage, storageId, 'application/json');
	if (!url) {
		await ctx.storage.delete(storageId);
		throw new Error('Could not stage account export content');
	}
	return url;
}

/**
 * Get all data for a user (for GDPR data export)
 * Returns all teams the user belongs to and all data within those teams
 */
// authz: self — every internal export page rechecks args.userId against the session.
export const exportUserData = authedAction({
	args: {
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<AccountExportManifest> => {
		const userProfile: Doc<'userProfiles'> = await ctx.runQuery(
			internal.auth.accountExport.getProfile,
			{
				userId: args.userId,
			}
		);

		return {
			userProfile: {
				email: userProfile.email,
				name: userProfile.name,
				image: userProfile.image,
				createdAt: userProfile.createdAt,
				updatedAt: userProfile.updatedAt,
			},
			exportedAt: Date.now(),
		};
	},
});

// authz: self — every page rechecks args.userId before reading export data.
export const exportUserDataPage = authedAction({
	args: {
		userId: v.string(),
		resource: accountExportResourceValidator,
		cursor: v.optional(v.string()),
		organizationId: v.optional(v.string()),
		mailboxId: v.optional(v.id('mailboxes')),
	},
	handler: async (ctx, args): Promise<SerializedAccountExportPage> => {
		const profile: Doc<'userProfiles'> = await ctx.runQuery(
			internal.auth.accountExport.getProfile,
			{ userId: args.userId }
		);
		const bodyResource = args.resource === 'mailMessages' || args.resource === 'mailDrafts';
		const paginationOpts = {
			cursor: args.cursor ?? null,
			numItems: bodyResource ? ACCOUNT_EXPORT_BODY_PAGE_SIZE : ACCOUNT_EXPORT_PAGE_SIZE,
		};
		if (args.resource === 'organizationMemberships') {
			const result: {
				page?: unknown[];
				isDone?: boolean;
				continueCursor?: string;
			} | null = await ctx.runQuery(components.betterAuth.adapter.findMany, {
				model: 'member',
				where: [{ field: 'userId', value: profile.authUserId }],
				paginationOpts,
			});
			const memberships = (result?.page ?? []) as Array<{
				organizationId: string;
				role: string;
			}>;
			const page = (
				await Promise.all(
					memberships.map(async (membership) => {
						const organization = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
							model: 'organization',
							where: [{ field: '_id', value: membership.organizationId }],
						})) as { _id: string; name: string; slug?: string | null } | null;
						return organization
							? {
									organizationId: membership.organizationId,
									role: membership.role,
									organization: {
										_id: organization._id,
										name: organization.name,
										slug: organization.slug,
									},
								}
							: null;
					})
				)
			).filter((row) => row !== null);
			return serializeAccountExportPage({
				page,
				isDone: result?.isDone ?? true,
				continueCursor: result?.continueCursor ?? '',
			});
		}
		if (isAccountExportOrganizationResource(args.resource)) {
			if (!args.organizationId) throw new Error('Organization export page requires organizationId');
			return (await ctx.runQuery(internal.auth.accountExport.listOrganizationData, {
				userId: args.userId,
				organizationId: args.organizationId,
				table: args.resource,
				paginationOpts,
			})) as SerializedAccountExportPage;
		}
		if (args.resource === 'mailboxes') {
			const result = (await ctx.runQuery(internal.auth.accountExport.listPersonalMailboxes, {
				userId: args.userId,
				paginationOpts,
			})) as PaginationResult<Doc<'mailboxes'>>;
			return serializeAccountExportPage(result);
		}
		if (args.resource === 'mailMessages') {
			if (!args.mailboxId) throw new Error('Mail message export page requires mailboxId');
			const result = (await ctx.runQuery(internal.auth.accountExport.listMailboxMessages, {
				userId: args.userId,
				mailboxId: args.mailboxId,
				paginationOpts,
			})) as PaginationResult<Doc<'mailMessages'>>;
			const page = await Promise.all(
				result.page.map(async (message) => {
					const bodies = await readMailMessageBodiesForAccountExport(ctx.storage, message);
					const contentDownloadUrl = await stageAccountExportContent(ctx, bodies);
					const {
						rawStorageId: _raw,
						textBodyStorageId: _textStorage,
						htmlBodyStorageId: _htmlStorage,
						textBodyInline: _textInline,
						htmlBodyInline: _htmlInline,
						...safeMessage
					} = message;
					return { ...safeMessage, contentDownloadUrl };
				})
			);
			return serializeAccountExportPage({ ...result, page });
		}
		if (args.resource === 'mailDrafts') {
			if (!args.mailboxId) throw new Error('Mail draft export page requires mailboxId');
			const result = (await ctx.runQuery(internal.auth.accountExport.listMailboxDrafts, {
				userId: args.userId,
				mailboxId: args.mailboxId,
				paginationOpts,
			})) as PaginationResult<Doc<'mailDrafts'>>;
			const page = await Promise.all(
				result.page.map(async (draft) => {
					const opened = await openMailDraftForAccountExport(ctx.storage, draft);
					const { bodyHtml, bodyText, bodyBlocks, bodyAvailability, attachments, ...safeDraft } =
						opened;
					const contentDownloadUrl = await stageAccountExportContent(ctx, {
						bodyHtml,
						...(bodyText === undefined ? {} : { bodyText }),
						...(bodyBlocks === undefined ? {} : { bodyBlocks }),
						bodyAvailability,
						attachments,
					});
					return {
						...safeDraft,
						attachments: attachments.map(
							({ contentBase64: _content, ...attachment }) => attachment
						),
						contentDownloadUrl,
					};
				})
			);
			return serializeAccountExportPage({ ...result, page });
		}
		if (args.resource === 'externalMailAccounts') {
			const result = (await ctx.runQuery(internal.auth.accountExport.listPersonalExternalAccounts, {
				userId: args.userId,
				paginationOpts,
			})) as PaginationResult<Record<string, unknown>>;
			return serializeAccountExportPage(result);
		}
		if (args.resource === 'chatMessages') {
			const result = (await ctx.runQuery(internal.auth.accountExport.listPersonalChatMessages, {
				userId: args.userId,
				paginationOpts,
			})) as PaginationResult<Doc<'chatMessages'>>;
			return serializeAccountExportPage(result);
		}
		const result = (await ctx.runQuery(
			internal.auth.accountExport.listDeliverabilityAlertRecipientStates,
			{
				userId: args.userId,
				paginationOpts,
			}
		)) as PaginationResult<Record<string, unknown>>;
		return serializeAccountExportPage(result);
	},
});

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
