import type { FunctionReference, PaginationOptions, PaginationResult } from 'convex/server';
import { v } from 'convex/values';
import { literalUnion } from '../lib/literalUnion';
import {
	ACCOUNT_EXPORT_ORGANIZATION_RESOURCES,
	ACCOUNT_EXPORT_PERSONAL_RESOURCES,
	isAccountExportOrganizationResource,
	serializeAccountExportPage,
	type AccountExportManifest,
	type SerializedAccountExportPage,
} from '@owlat/shared';
import { components, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
import { authedAction } from '../lib/authedFunctions';
import { throwInvalidInput } from '../_utils/errors';
import {
	openEmailTemplateContent,
	openTransactionalEmailContent,
	projectEmailTemplateMetadata,
	projectTransactionalEmailMetadata,
	referencedTemplateMediaAssetIds,
} from '../lib/accountExportTemplates';
import {
	openMailDraftForAccountExport,
	readMailMessageBodiesForAccountExport,
} from '../lib/messageBodyExport';
import { sealedBlobUrl, storeSealedBlob } from '../lib/sealedBlob';
import {
	artifactScope,
	exportPageSize,
	mailMessageExportRow,
	membershipExportRows,
	splitDraftForExport,
} from './accountExportDecision';

/** How often one row restages when its artifact keeps changing under it. */
const MAX_STAGING_PASSES = 3;
const accountExportResourceValidator = literalUnion([
	'organizationMemberships',
	...ACCOUNT_EXPORT_ORGANIZATION_RESOURCES,
	...ACCOUNT_EXPORT_PERSONAL_RESOURCES,
]);

/** The personal resources that page by user alone (no mailbox, no organization). */
const USER_SCOPED_EXPORT_QUERIES: Record<
	| 'externalMailAccounts'
	| 'savedReplies'
	| 'chatMessages'
	| 'threadNotes'
	| 'deliverabilityAlertRecipientStates'
	| 'bookingPages'
	| 'bookings'
	| 'pushSubscriptions'
	| 'threadViewerState',
	FunctionReference<'query', 'internal', { userId: string; paginationOpts: PaginationOptions }>
> = {
	externalMailAccounts: internal.auth.accountExportQueries.listPersonalExternalAccounts,
	savedReplies: internal.auth.accountExportQueries.listPersonalSavedReplies,
	chatMessages: internal.auth.accountExportQueries.listPersonalChatMessages,
	threadNotes: internal.auth.accountExportQueries.listPersonalThreadNotes,
	deliverabilityAlertRecipientStates:
		internal.auth.accountExportQueries.listDeliverabilityAlertRecipientStates,
	bookingPages: internal.auth.accountExportBookingQueries.listBookingPages,
	bookings: internal.auth.accountExportBookingQueries.listBookings,
	pushSubscriptions: internal.auth.accountExportPushQueries.listPersonalPushSubscriptions,
	threadViewerState: internal.auth.accountExportThreadBriefQueries.listOwnThreadViewerState,
};

async function contentAddressedArtifactKey(scope: string, bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
	const digestHex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${scope}:${digestHex}`;
}

async function artifactUrl(ctx: ActionCtx, storageId: Id<'_storage'>): Promise<string> {
	const url = await sealedBlobUrl(ctx.storage, storageId, 'application/json');
	if (!url) throw new Error('Could not create account export artifact URL');
	return url;
}

interface StagedAccountExportContent {
	contentDownloadUrl: string;
	contentArtifactId: Id<'accountExportArtifacts'>;
	contentLeaseToken: string;
}

/**
 * Stage one row's content as a leased artifact. The download link is minted
 * before the lease is taken, so a link that cannot be minted leaves no lease
 * behind; a blob stored here that ends up registered by nobody is deleted.
 */
async function stageAccountExportContent(
	ctx: ActionCtx,
	args: {
		userId: string;
		sessionId: Id<'accountExportSessions'>;
		artifactScope: string;
		content: Record<string, unknown>;
	}
): Promise<StagedAccountExportContent> {
	const bytes = new TextEncoder().encode(JSON.stringify(args.content));
	const owner = { userId: args.userId, sessionId: args.sessionId };
	const artifactKey = await contentAddressedArtifactKey(args.artifactScope, bytes);
	const leaseToken = crypto.randomUUID();
	let found: Doc<'accountExportArtifacts'> | null = await ctx.runQuery(
		internal.auth.accountExportArtifacts.findArtifact,
		{ ...owner, artifactKey }
	);
	for (let pass = 0; pass < MAX_STAGING_PASSES; pass++) {
		const isFreshBlob = found === null;
		const storageId = found
			? found.storageId
			: await storeSealedBlob(ctx.storage, bytes, 'application/json');
		try {
			const contentDownloadUrl = await artifactUrl(ctx, storageId);
			// checkpoint: a staged artifact stands alone; its content-addressed key
			// lets a retried page lease it again instead of staging it twice, and
			// one never acknowledged is swept with its session (expireSession).
			const staged = await ctx.runMutation(internal.auth.accountExportArtifacts.stageArtifact, {
				...owner,
				artifactKey,
				storageId,
				isFreshBlob,
				contentLength: bytes.byteLength,
				leaseToken,
			});
			if (staged.kind === 'staged') {
				return {
					contentDownloadUrl,
					contentArtifactId: staged.artifactId,
					contentLeaseToken: leaseToken,
				};
			}
			// The artifact found was released, or another blob took the key, in between.
			found = staged.artifact;
		} catch (error) {
			if (isFreshBlob) await discardUnregisteredBlob(ctx, { ...owner, artifactKey }, storageId);
			throw error;
		}
	}
	throw new Error('Account export artifact changed while it was staged; retry the page');
}

/** Delete a blob this page stored unless the session's artifact under the key holds it. */
async function discardUnregisteredBlob(
	ctx: ActionCtx,
	args: { userId: string; sessionId: Id<'accountExportSessions'>; artifactKey: string },
	storageId: Id<'_storage'>
): Promise<void> {
	try {
		const registered = await ctx.runQuery(internal.auth.accountExportArtifacts.findArtifact, args);
		if (!registered || registered.storageId !== storageId) await ctx.storage.delete(storageId);
	} catch {
		await ctx.storage.delete(storageId);
	}
}

/**
 * The manifest the "Export my data" card shows BEFORE the export runs (idea 67).
 *
 * Names every resource the download will contain and, for the personal ones,
 * how many rows that is. Organization resources are listed without a count —
 * counting them would re-walk exactly the rows the export is about to stream —
 * so the card says "counted as it exports" for those rather than inventing a
 * number. Nothing here starts an export session or stages an artifact: it is a
 * read the user can take before deciding.
 */
// authz: self — getPersonalExportCounts enforces args.userId
export const getExportPlan = authedAction({
	args: { userId: v.string() },
	handler: async (
		ctx,
		args
	): Promise<{
		personal: Array<{ resource: string; count: number; isCapped: boolean }>;
		organizationResources: string[];
	}> => {
		const personal: Array<{ resource: string; count: number; isCapped: boolean }> =
			await ctx.runQuery(internal.auth.accountExportQueries.getPersonalExportCounts, {
				userId: args.userId,
			});
		return {
			personal,
			organizationResources: [...ACCOUNT_EXPORT_ORGANIZATION_RESOURCES],
		};
	},
});

/** Start or resume the caller's bounded, short-lived GDPR export session. */
// authz: self — beginSession and getProfile both enforce args.userId.
export const exportUserData = authedAction({
	args: { userId: v.string() },
	handler: async (ctx, args): Promise<AccountExportManifest> => {
		const userProfile: Doc<'userProfiles'> = await ctx.runQuery(
			internal.auth.accountExportQueries.getProfile,
			{ userId: args.userId }
		);
		const sessionId: Id<'accountExportSessions'> = await ctx.runMutation(
			internal.auth.accountExportArtifacts.beginSession,
			{ userId: args.userId }
		);
		return {
			exportSessionId: sessionId,
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

/** Delete a staged artifact after the caller has streamed it successfully.
 * Repeated acknowledgements are harmless and still renew active progress. */
// authz: self — releaseArtifact verifies both session and artifact ownership.
export const acknowledgeExportArtifact = authedAction({
	args: {
		userId: v.string(),
		exportSessionId: v.id('accountExportSessions'),
		artifactId: v.id('accountExportArtifacts'),
		leaseToken: v.string(),
	},
	handler: async (ctx, args): Promise<boolean> =>
		ctx.runMutation(internal.auth.accountExportArtifacts.releaseArtifact, {
			userId: args.userId,
			sessionId: args.exportSessionId,
			artifactId: args.artifactId,
			leaseToken: args.leaseToken,
		}),
});

// authz: self — every query and artifact mutation rechecks user + export session ownership.
export const exportUserDataPage = authedAction({
	args: {
		userId: v.string(),
		exportSessionId: v.id('accountExportSessions'),
		resource: accountExportResourceValidator,
		cursor: v.optional(v.string()),
		organizationId: v.optional(v.string()),
		mailboxId: v.optional(v.id('mailboxes')),
	},
	handler: async (ctx, args): Promise<SerializedAccountExportPage> => {
		const profile: Doc<'userProfiles'> = await ctx.runQuery(
			internal.auth.accountExportQueries.getProfile,
			{ userId: args.userId }
		);
		await ctx.runMutation(internal.auth.accountExportArtifacts.validateActiveSession, {
			userId: args.userId,
			sessionId: args.exportSessionId,
		});
		const paginationOpts = { cursor: args.cursor ?? null, numItems: exportPageSize(args.resource) };
		const stage = (rowId: string, content: Record<string, unknown>) =>
			stageAccountExportContent(ctx, {
				userId: args.userId,
				sessionId: args.exportSessionId,
				artifactScope: artifactScope(args.resource, rowId),
				content,
			});
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
			const organizations = await Promise.all(
				memberships.map(
					async (membership) =>
						(await ctx.runQuery(components.betterAuth.adapter.findOne, {
							model: 'organization',
							where: [{ field: '_id', value: membership.organizationId }],
						})) as { _id: string; name: string; slug?: string | null } | null
				)
			);
			return serializeAccountExportPage({
				page: membershipExportRows(memberships, organizations),
				isDone: result?.isDone ?? true,
				continueCursor: result?.continueCursor ?? '',
			});
		}
		if (args.resource === 'emailTemplates' || args.resource === 'transactionalEmails') {
			if (!args.organizationId) throwInvalidInput('Template export page requires organizationId');
			const result = (await ctx.runQuery(
				internal.auth.accountExportQueries.listTemplateContentData,
				{
					userId: args.userId,
					organizationId: args.organizationId,
					table: args.resource,
					paginationOpts,
				}
			)) as PaginationResult<Doc<'emailTemplates'>> | PaginationResult<Doc<'transactionalEmails'>>;
			const page: Record<string, unknown>[] = [];
			for (const template of result.page) {
				const isEmailTemplate = args.resource === 'emailTemplates';
				const mediaAssetIds = referencedTemplateMediaAssetIds(template);
				const authorizedMedia: Array<{ mediaAssetId: string; storageId: string }> = [];
				for (let offset = 0; offset < mediaAssetIds.length; offset += 200) {
					authorizedMedia.push(
						...(await ctx.runQuery(internal.auth.accountExportQueries.listAuthorizedTemplateMedia, {
							userId: args.userId,
							organizationId: args.organizationId!,
							mediaAssetIds: mediaAssetIds.slice(offset, offset + 200),
						}))
					);
				}
				const content = isEmailTemplate
					? await openEmailTemplateContent(
							ctx.storage,
							template as Doc<'emailTemplates'>,
							authorizedMedia
						)
					: await openTransactionalEmailContent(
							ctx.storage,
							template as Doc<'transactionalEmails'>,
							authorizedMedia
						);
				const stagedContent = await stage(template._id, content);
				page.push({
					...(isEmailTemplate
						? projectEmailTemplateMetadata(template as Doc<'emailTemplates'>)
						: projectTransactionalEmailMetadata(template as Doc<'transactionalEmails'>)),
					...stagedContent,
				});
			}
			return serializeAccountExportPage({ ...result, page });
		}
		if (isAccountExportOrganizationResource(args.resource)) {
			if (!args.organizationId)
				throwInvalidInput('Organization export page requires organizationId');
			return (await ctx.runQuery(internal.auth.accountExportQueries.listOrganizationData, {
				userId: args.userId,
				organizationId: args.organizationId,
				table: args.resource,
				paginationOpts,
			})) as SerializedAccountExportPage;
		}
		if (args.resource === 'mailboxes') {
			const result = (await ctx.runQuery(internal.auth.accountExportQueries.listPersonalMailboxes, {
				userId: args.userId,
				paginationOpts,
			})) as PaginationResult<Doc<'mailboxes'>>;
			return serializeAccountExportPage(result);
		}
		if (args.resource === 'mailMessages') {
			if (!args.mailboxId) throwInvalidInput('Mail message export page requires mailboxId');
			const result = (await ctx.runQuery(internal.auth.accountExportQueries.listMailboxMessages, {
				userId: args.userId,
				mailboxId: args.mailboxId,
				paginationOpts,
			})) as PaginationResult<Doc<'mailMessages'>>;
			const page = await Promise.all(
				result.page.map(async (message) => {
					const bodies = await readMailMessageBodiesForAccountExport(ctx.storage, message);
					return { ...mailMessageExportRow(message), ...(await stage(message._id, bodies)) };
				})
			);
			return serializeAccountExportPage({ ...result, page });
		}
		if (args.resource === 'mailDrafts') {
			if (!args.mailboxId) throwInvalidInput('Mail draft export page requires mailboxId');
			const result = (await ctx.runQuery(internal.auth.accountExportQueries.listMailboxDrafts, {
				userId: args.userId,
				mailboxId: args.mailboxId,
				paginationOpts,
			})) as PaginationResult<Doc<'mailDrafts'>>;
			const page = await Promise.all(
				result.page.map(async (draft) => {
					const opened = await openMailDraftForAccountExport(ctx.storage, draft);
					const { row, content } = splitDraftForExport(opened);
					return { ...row, ...(await stage(draft._id, content)) };
				})
			);
			return serializeAccountExportPage({ ...result, page });
		}
		if (args.resource === 'threadBriefs') {
			if (!args.mailboxId) throwInvalidInput('Thread brief export page requires mailboxId');
			const query = internal.auth.accountExportThreadBriefQueries.listMailboxThreadBriefs;
			const result = await ctx.runQuery(query, {
				userId: args.userId,
				mailboxId: args.mailboxId,
				paginationOpts,
			});
			return serializeAccountExportPage(result);
		}
		const result = (await ctx.runQuery(USER_SCOPED_EXPORT_QUERIES[args.resource], {
			userId: args.userId,
			paginationOpts,
		})) as PaginationResult<Record<string, unknown>>;
		return serializeAccountExportPage(result);
	},
});
