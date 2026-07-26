import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { ACCOUNT_EXPORT_ORGANIZATION_RESOURCES, serializeAccountExportPage } from '@owlat/shared';
import { components } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
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
				page: result.page.map(
					({ doiConfirmationToken: _confirmationCapability, ...contact }) => contact
				),
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
		const result = await ctx.db
			.query('deliverabilityAlertRecipients')
			.withIndex('by_user', (q) => q.eq('userId', args.userId))
			.paginate(args.paginationOpts);
		return {
			...result,
			page: result.page.map((recipient) => ({
				alertId: recipient.alertId,
				organizationId: recipient.organizationId,
				state: toDeliverabilityAlertRecipientState(recipient),
			})),
		};
	},
});
