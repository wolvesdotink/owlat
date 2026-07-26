import type { PaginationResult } from 'convex/server';
import { v } from 'convex/values';
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

const ACCOUNT_EXPORT_PAGE_SIZE = 100;
const ACCOUNT_EXPORT_CONTENT_PAGE_SIZE = 1;
const accountExportResourceValidator = v.union(
	v.literal('organizationMemberships'),
	...ACCOUNT_EXPORT_ORGANIZATION_RESOURCES.map((resource) => v.literal(resource)),
	...ACCOUNT_EXPORT_PERSONAL_RESOURCES.map((resource) => v.literal(resource))
);

function isContentResource(resource: string): boolean {
	return (
		resource === 'mailMessages' ||
		resource === 'mailDrafts' ||
		resource === 'emailTemplates' ||
		resource === 'transactionalEmails'
	);
}

function artifactScope(resource: string, rowId: string): string {
	return `${resource}:${rowId}`;
}

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

async function releaseStagedArtifactLease(
	ctx: ActionCtx,
	args: {
		userId: string;
		sessionId: Id<'accountExportSessions'>;
		artifactId: Id<'accountExportArtifacts'>;
		leaseToken: string;
	}
): Promise<void> {
	await ctx
		.runMutation(internal.auth.accountExportArtifacts.releaseArtifact, args)
		.catch(() => undefined);
}

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
	const artifactKey = await contentAddressedArtifactKey(args.artifactScope, bytes);
	const leaseToken = crypto.randomUUID();
	const existing: Doc<'accountExportArtifacts'> | null = await ctx.runQuery(
		internal.auth.accountExportArtifacts.findArtifact,
		{
			userId: args.userId,
			sessionId: args.sessionId,
			artifactKey,
		}
	);
	if (existing) {
		const leasedArtifact: Doc<'accountExportArtifacts'> | null = await ctx.runMutation(
			internal.auth.accountExportArtifacts.acquireArtifactLease,
			{
				userId: args.userId,
				sessionId: args.sessionId,
				artifactId: existing._id,
				leaseToken,
			}
		);
		if (leasedArtifact) {
			try {
				return {
					contentDownloadUrl: await artifactUrl(ctx, leasedArtifact.storageId),
					contentArtifactId: leasedArtifact._id,
					contentLeaseToken: leaseToken,
				};
			} catch (error) {
				await releaseStagedArtifactLease(ctx, {
					userId: args.userId,
					sessionId: args.sessionId,
					artifactId: leasedArtifact._id,
					leaseToken,
				});
				throw error;
			}
		}
		// The last prior consumer may have acknowledged between the lookup and
		// lease mutation. Restage below instead of failing a retry-safe page.
	}

	const storageId = await storeSealedBlob(ctx.storage, bytes, 'application/json');
	try {
		const registered: { artifact: Doc<'accountExportArtifacts'>; created: boolean } =
			await ctx.runMutation(internal.auth.accountExportArtifacts.registerArtifact, {
				userId: args.userId,
				sessionId: args.sessionId,
				artifactKey,
				storageId,
				contentLength: bytes.byteLength,
				leaseToken,
			});
		if (!registered.created) await ctx.storage.delete(storageId);
		try {
			return {
				contentDownloadUrl: await artifactUrl(ctx, registered.artifact.storageId),
				contentArtifactId: registered.artifact._id,
				contentLeaseToken: leaseToken,
			};
		} catch (error) {
			await releaseStagedArtifactLease(ctx, {
				userId: args.userId,
				sessionId: args.sessionId,
				artifactId: registered.artifact._id,
				leaseToken,
			});
			throw error;
		}
	} catch (error) {
		try {
			const registered = await ctx.runQuery(internal.auth.accountExportArtifacts.findArtifact, {
				userId: args.userId,
				sessionId: args.sessionId,
				artifactKey,
			});
			if (!registered || registered.storageId !== storageId) await ctx.storage.delete(storageId);
		} catch {
			await ctx.storage.delete(storageId);
		}
		throw error;
	}
}

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
		const paginationOpts = {
			cursor: args.cursor ?? null,
			numItems: isContentResource(args.resource)
				? ACCOUNT_EXPORT_CONTENT_PAGE_SIZE
				: ACCOUNT_EXPORT_PAGE_SIZE,
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
		if (args.resource === 'emailTemplates' || args.resource === 'transactionalEmails') {
			if (!args.organizationId) throw new Error('Template export page requires organizationId');
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
				const stagedContent = await stageAccountExportContent(ctx, {
					userId: args.userId,
					sessionId: args.exportSessionId,
					artifactScope: artifactScope(args.resource, template._id),
					content,
				});
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
			if (!args.organizationId) throw new Error('Organization export page requires organizationId');
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
			if (!args.mailboxId) throw new Error('Mail message export page requires mailboxId');
			const result = (await ctx.runQuery(internal.auth.accountExportQueries.listMailboxMessages, {
				userId: args.userId,
				mailboxId: args.mailboxId,
				paginationOpts,
			})) as PaginationResult<Doc<'mailMessages'>>;
			const page = await Promise.all(
				result.page.map(async (message) => {
					const bodies = await readMailMessageBodiesForAccountExport(ctx.storage, message);
					const stagedContent = await stageAccountExportContent(ctx, {
						userId: args.userId,
						sessionId: args.exportSessionId,
						artifactScope: artifactScope(args.resource, message._id),
						content: bodies,
					});
					const {
						rawStorageId: _raw,
						textBodyStorageId: _textStorage,
						htmlBodyStorageId: _htmlStorage,
						textBodyInline: _textInline,
						htmlBodyInline: _htmlInline,
						...safeMessage
					} = message;
					return { ...safeMessage, ...stagedContent };
				})
			);
			return serializeAccountExportPage({ ...result, page });
		}
		if (args.resource === 'mailDrafts') {
			if (!args.mailboxId) throw new Error('Mail draft export page requires mailboxId');
			const result = (await ctx.runQuery(internal.auth.accountExportQueries.listMailboxDrafts, {
				userId: args.userId,
				mailboxId: args.mailboxId,
				paginationOpts,
			})) as PaginationResult<Doc<'mailDrafts'>>;
			const page = await Promise.all(
				result.page.map(async (draft) => {
					const opened = await openMailDraftForAccountExport(ctx.storage, draft);
					const { bodyHtml, bodyText, bodyBlocks, bodyAvailability, attachments, ...safeDraft } =
						opened;
					const stagedContent = await stageAccountExportContent(ctx, {
						userId: args.userId,
						sessionId: args.exportSessionId,
						artifactScope: artifactScope(args.resource, draft._id),
						content: {
							bodyHtml,
							...(bodyText === undefined ? {} : { bodyText }),
							...(bodyBlocks === undefined ? {} : { bodyBlocks }),
							bodyAvailability,
							attachments,
						},
					});
					return {
						...safeDraft,
						attachments: attachments.map(
							({ contentBase64: _content, ...attachment }) => attachment
						),
						...stagedContent,
					};
				})
			);
			return serializeAccountExportPage({ ...result, page });
		}
		if (args.resource === 'externalMailAccounts') {
			const result = (await ctx.runQuery(
				internal.auth.accountExportQueries.listPersonalExternalAccounts,
				{ userId: args.userId, paginationOpts }
			)) as PaginationResult<Record<string, unknown>>;
			return serializeAccountExportPage(result);
		}
		if (args.resource === 'chatMessages') {
			const result = (await ctx.runQuery(
				internal.auth.accountExportQueries.listPersonalChatMessages,
				{ userId: args.userId, paginationOpts }
			)) as PaginationResult<Doc<'chatMessages'>>;
			return serializeAccountExportPage(result);
		}
		const result = (await ctx.runQuery(
			internal.auth.accountExportQueries.listDeliverabilityAlertRecipientStates,
			{ userId: args.userId, paginationOpts }
		)) as PaginationResult<Record<string, unknown>>;
		return serializeAccountExportPage(result);
	},
});
