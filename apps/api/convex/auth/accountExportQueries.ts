import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { ACCOUNT_EXPORT_ORGANIZATION_RESOURCES, serializeAccountExportPage } from '@owlat/shared';
import { components } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
import { redactContactCapabilityFields } from '../contacts/listing';
import { toDeliverabilityAlertRecipientState } from '../delivery/checklistAlertRecipients';
import { hasPermission, loadOwnUserProfile, requireSelf } from '../lib/sessionOrganization';
import type { OrganizationRole } from '../lib/sessionOrganization';
import { loadPersonalMailboxForUser } from '../mail/permissions';
import { throwNotFound } from '../_utils/errors';

const organizationExportTableValidator = v.union(
	...ACCOUNT_EXPORT_ORGANIZATION_RESOURCES.map((resource) => v.literal(resource))
);
async function hasOrganizationExportAccess(
	ctx: Parameters<typeof requireSelf>[0],
	userId: string,
	organizationId: string
): Promise<boolean> {
	await requireSelf(ctx, userId);
	const membership = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
		model: 'member',
		where: [
			{ field: 'organizationId', value: organizationId },
			{ field: 'userId', value: userId },
		],
	})) as { role: string } | null;
	return (
		membership !== null && hasPermission(membership.role as OrganizationRole, 'organization:manage')
	);
}

export const getProfile = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		const profile = await loadOwnUserProfile(ctx, args.userId);
		if (!profile) throwNotFound('User profile');
		return profile;
	},
});

export const listOrganizationData = internalQuery({
	args: {
		userId: v.string(),
		organizationId: v.string(),
		table: organizationExportTableValidator,
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		if (!(await hasOrganizationExportAccess(ctx, args.userId, args.organizationId))) {
			return {
				pageJson: [],
				isDone: true,
				continueCursor: args.paginationOpts.cursor ?? '',
			};
		}
		if (args.table === 'contacts') {
			const result = await ctx.db
				.query('contacts')
				.withIndex('by_deleted_at_and_created_at', (q) => q.eq('deletedAt', undefined))
				.paginate(args.paginationOpts);
			return serializeAccountExportPage({
				...result,
				// One redactor, shared with the listing engine's `redact` hook and
				// the non-listing contact reads — the strip is defined once.
				page: result.page.map(redactContactCapabilityFields),
			});
		}
		if (args.table === 'apiKeys') {
			const result = await ctx.db.query('apiKeys').paginate(args.paginationOpts);
			return serializeAccountExportPage({
				...result,
				page: result.page.map((key) => ({
					name: key.name,
					keyPrefix: key.keyPrefix,
					createdAt: key.createdAt,
					lastUsedAt: key.lastUsedAt,
				})),
			});
		}
		if (args.table === 'webhooks') {
			const result = await ctx.db.query('webhooks').paginate(args.paginationOpts);
			return serializeAccountExportPage({
				...result,
				page: result.page.map(({ secret: _secret, ...webhook }) => webhook),
			});
		}
		switch (args.table) {
			case 'contactProperties':
				return serializeAccountExportPage(
					await ctx.db.query('contactProperties').paginate(args.paginationOpts)
				);
			case 'topics':
				return serializeAccountExportPage(
					await ctx.db.query('topics').paginate(args.paginationOpts)
				);
			case 'campaigns': {
				const result = await ctx.db.query('campaigns').paginate(args.paginationOpts);
				return serializeAccountExportPage({
					...result,
					page: result.page.map(({ archiveToken: _archiveCapability, ...campaign }) => campaign),
				});
			}
			case 'automations':
				return serializeAccountExportPage(
					await ctx.db.query('automations').paginate(args.paginationOpts)
				);
			case 'segments':
				return serializeAccountExportPage(
					await ctx.db.query('segments').paginate(args.paginationOpts)
				);
			case 'domains':
				return serializeAccountExportPage(
					await ctx.db.query('domains').paginate(args.paginationOpts)
				);
			case 'formEndpoints':
				return serializeAccountExportPage(
					await ctx.db.query('formEndpoints').paginate(args.paginationOpts)
				);
			case 'blockedEmails':
				return serializeAccountExportPage(
					await ctx.db.query('blockedEmails').paginate(args.paginationOpts)
				);
		}
	},
});

/** Raw rows remain internal to the action boundary. The public projection in
 * accountExport.ts is an explicit allowlist, so future table fields fail closed. */
export const listTemplateContentData = internalQuery({
	args: {
		userId: v.string(),
		organizationId: v.string(),
		table: v.union(v.literal('emailTemplates'), v.literal('transactionalEmails')),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		if (!(await hasOrganizationExportAccess(ctx, args.userId, args.organizationId))) {
			return {
				page: [],
				isDone: true,
				continueCursor: args.paginationOpts.cursor ?? '',
			};
		}
		return args.table === 'emailTemplates'
			? ctx.db.query('emailTemplates').paginate(args.paginationOpts)
			: ctx.db.query('transactionalEmails').paginate(args.paginationOpts);
	},
});

/** Resolve only media-library rows that the authorized template export names by
 * durable asset ID. The action then requires the stored blob ID to match this
 * projection exactly; arbitrary cross-resource storage IDs remain unavailable. */
export const listAuthorizedTemplateMedia = internalQuery({
	args: {
		userId: v.string(),
		organizationId: v.string(),
		mediaAssetIds: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		if (!(await hasOrganizationExportAccess(ctx, args.userId, args.organizationId))) return [];
		const assets: Array<{ mediaAssetId: string; storageId: string }> = [];
		for (const candidate of args.mediaAssetIds) {
			const assetId = ctx.db.normalizeId('mediaAssets', candidate);
			if (!assetId) continue;
			const asset = await ctx.db.get(assetId);
			if (asset) assets.push({ mediaAssetId: asset._id, storageId: asset.storageId });
		}
		return assets;
	},
});

export const listPersonalMailboxes = internalQuery({
	args: { userId: v.string(), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		const result = await ctx.db
			.query('mailboxes')
			.withIndex('by_user', (q) => q.eq('userId', args.userId))
			.paginate(args.paginationOpts);
		return { ...result, page: result.page.filter((mailbox) => mailbox.scope !== 'shared') };
	},
});

async function ownedPersonalMailbox(
	ctx: Parameters<typeof requireSelf>[0],
	userId: string,
	mailboxId: Doc<'mailboxes'>['_id']
): Promise<Doc<'mailboxes'>> {
	await requireSelf(ctx, userId);
	const mailbox = await loadPersonalMailboxForUser(ctx, mailboxId, userId);
	if (!mailbox) {
		throwNotFound('Personal mailbox');
	}
	return mailbox;
}

export const listMailboxMessages = internalQuery({
	args: {
		userId: v.string(),
		mailboxId: v.id('mailboxes'),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		await ownedPersonalMailbox(ctx, args.userId, args.mailboxId);
		return ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
			.paginate(args.paginationOpts);
	},
});

export const listMailboxDrafts = internalQuery({
	args: {
		userId: v.string(),
		mailboxId: v.id('mailboxes'),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		await ownedPersonalMailbox(ctx, args.userId, args.mailboxId);
		return ctx.db
			.query('mailDrafts')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.paginate(args.paginationOpts);
	},
});

export const listPersonalExternalAccounts = internalQuery({
	args: { userId: v.string(), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		const result = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', args.userId))
			.paginate(args.paginationOpts);
		return {
			...result,
			page: result.page
				.filter((account) => account.scope !== 'shared')
				.map(
					({ secretCiphertext: _ct, secretIv: _iv, secretAuthTag: _tag, ...account }) => account
				),
		};
	},
});

export const listPersonalChatMessages = internalQuery({
	args: { userId: v.string(), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		return ctx.db
			.query('chatMessages')
			.withIndex('by_author', (q) => q.eq('authorId', args.userId))
			.paginate(args.paginationOpts);
	},
});

export const listDeliverabilityAlertRecipientStates = internalQuery({
	args: { userId: v.string(), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		const receiptCursorPrefix = 'receipts:';
		if (args.paginationOpts.cursor?.startsWith(receiptCursorPrefix)) {
			const receiptResult = await ctx.db
				.query('deliverabilityAlertRecipientReceipts')
				.withIndex('by_user', (q) => q.eq('userId', args.userId))
				.paginate({
					...args.paginationOpts,
					cursor: args.paginationOpts.cursor.slice(receiptCursorPrefix.length) || null,
				});
			return {
				...receiptResult,
				continueCursor: receiptResult.isDone
					? ''
					: `${receiptCursorPrefix}${receiptResult.continueCursor}`,
				page: receiptResult.page.map((receipt) => ({
					alertId: receipt.alertId,
					organizationId: receipt.organizationId,
					state: {
						userId: receipt.userId,
						status: receipt.outcome === 'sent' ? ('sent' as const) : ('unavailable' as const),
						attemptCount: 0,
						sentAt: receipt.sentAt,
						unavailableReason:
							receipt.outcome === 'transport_outcome_unknown'
								? ('transport_outcome_unknown' as const)
								: undefined,
					},
					compacted: true,
				})),
			};
		}
		const result = await ctx.db
			.query('deliverabilityAlertRecipients')
			.withIndex('by_user', (q) => q.eq('userId', args.userId))
			.paginate(args.paginationOpts);
		return {
			...result,
			isDone: false,
			continueCursor: result.isDone ? receiptCursorPrefix : result.continueCursor,
			page: result.page.map((recipient) => ({
				alertId: recipient.alertId,
				organizationId: recipient.organizationId,
				state: toDeliverabilityAlertRecipientState(recipient),
			})),
		};
	},
});

/**
 * The PRE-RUN manifest's row counts (idea 67).
 *
 * "Export my data" used to be one button and a spinner: nothing said what was
 * about to be written or how much of it there was, so a fifteen-minute export
 * of a large mailbox was indistinguishable from a hung one. This is the count
 * the manifest shows before the first byte is fetched.
 *
 * PERSONAL resources only. Every org resource is scoped through a membership
 * check per organization, and counting them would mean re-walking the same rows
 * the export is about to stream — i.e. paying for the export twice to describe
 * it. The org half of the manifest is therefore counted AS it streams; see
 * docs/ux-plan/DEFERRALS.md.
 *
 * Mail messages come from the per-folder `totalCount` aggregates, which the
 * delivery path already maintains, so the biggest number in the manifest costs
 * a handful of reads rather than a walk over years of mail. The remaining
 * counts are bounded by {@link EXPORT_COUNT_CAP}: past it the manifest says
 * "more than N" instead of pretending to a number it did not finish counting.
 */
export const EXPORT_COUNT_CAP = 2_000;

async function boundedCount<T>(query: {
	take: (n: number) => Promise<T[]>;
}): Promise<{ count: number; isCapped: boolean }> {
	const rows = await query.take(EXPORT_COUNT_CAP + 1);
	return {
		count: Math.min(rows.length, EXPORT_COUNT_CAP),
		isCapped: rows.length > EXPORT_COUNT_CAP,
	};
}

export const getPersonalExportCounts = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		const mailboxes = (
			await ctx.db
				.query('mailboxes')
				.withIndex('by_user', (q) => q.eq('userId', args.userId))
				.take(EXPORT_COUNT_CAP + 1)
		).filter((mailbox) => mailbox.scope !== 'shared');

		let mailMessages = 0;
		let mailDrafts = 0;
		let isDraftCountCapped = false;
		for (const mailbox of mailboxes) {
			const folders = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
				.collect(); // bounded: one mailbox's folders
			for (const folder of folders) mailMessages += folder.totalCount;
			const drafts = await boundedCount(
				ctx.db.query('mailDrafts').withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
			);
			mailDrafts += drafts.count;
			isDraftCountCapped ||= drafts.isCapped;
		}

		const externalMailAccounts = await boundedCount(
			ctx.db.query('externalMailAccounts').withIndex('by_user', (q) => q.eq('userId', args.userId))
		);
		const chatMessages = await boundedCount(
			ctx.db.query('chatMessages').withIndex('by_author', (q) => q.eq('authorId', args.userId))
		);
		const alertStates = await boundedCount(
			ctx.db
				.query('deliverabilityAlertRecipients')
				.withIndex('by_user', (q) => q.eq('userId', args.userId))
		);

		return [
			{ resource: 'mailboxes' as const, count: mailboxes.length, isCapped: false },
			{ resource: 'mailMessages' as const, count: mailMessages, isCapped: false },
			{ resource: 'mailDrafts' as const, count: mailDrafts, isCapped: isDraftCountCapped },
			{
				resource: 'externalMailAccounts' as const,
				count: externalMailAccounts.count,
				isCapped: externalMailAccounts.isCapped,
			},
			{
				resource: 'chatMessages' as const,
				count: chatMessages.count,
				isCapped: chatMessages.isCapped,
			},
			{
				resource: 'deliverabilityAlertRecipientStates' as const,
				count: alertStates.count,
				isCapped: alertStates.isCapped,
			},
		];
	},
});
