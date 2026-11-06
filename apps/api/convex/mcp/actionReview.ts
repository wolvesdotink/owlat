/**
 * What the owner reviews before approving an MCP action, and the digest that
 * binds the approval to it (`approve` and `listPending` in `mcp/actions.ts`).
 *
 * Not a Convex function module.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { htmlToPlainText } from '@owlat/shared/html';
import { openMailDraftBody } from '../lib/messageBody';
import { sha256Hex } from '../lib/aiRouting/routeDigest';
import { resolveMcpAccess } from './access';

/**
 * Can the action's client still reach its mailbox: the bound `approve`
 * enforces, so the card stops describing what approval would refuse.
 */
export async function canReach(
	ctx: QueryCtx,
	row: Doc<'mcpPendingActions'>,
	cache?: Map<Id<'mcpClients'>, Set<Id<'mailboxes'>>>
): Promise<boolean> {
	let reachable = cache?.get(row.clientId);
	if (!reachable) {
		const access = await resolveMcpAccess(ctx, row.clientId);
		reachable = new Set(
			access.ok && access.client.access === 'read_write'
				? access.mailboxes.map((mailbox) => mailbox._id)
				: []
		);
		cache?.set(row.clientId, reachable);
	}
	return reachable.has(row.mailboxId);
}

const INACCESSIBLE = { isInaccessible: true } as const;

type ThreadBase = { threadSubject?: string };

/** What the approval card shows; spelled out so the web can narrow it by field. */
export type McpActionDetails =
	| typeof INACCESSIBLE
	| (ThreadBase & { isDraftGone: true })
	| (ThreadBase & {
			to: string[];
			cc: string[];
			subject: string;
			body: string;
			inReplyToSubject?: string;
	  })
	| (ThreadBase & {
			from: { address: string; mailboxName: string | null; isSendAs: boolean };
			to: string[];
			cc: string[];
			bcc: string[];
			subject: string;
			body: string;
			attachments: Array<{ filename: string; size: number; isInline: boolean }>;
	  })
	| (ThreadBase & { folderName?: string })
	| (ThreadBase & { isRemoval: boolean; labelName?: string });

/** The From identity a draft goes out under; the header carries the address alone. */
async function fromIdentity(ctx: QueryCtx, draft: Doc<'mailDrafts'>) {
	const sending = await ctx.db.get(draft.sendAsMailboxId ?? draft.mailboxId);
	return {
		address: draft.fromAddress,
		mailboxName: sending?.displayName ?? sending?.address ?? null,
		isSendAs: draft.sendAsMailboxId !== undefined && draft.sendAsMailboxId !== draft.mailboxId,
	};
}

/**
 * What the approval card shows for one action, the live names behind its ids,
 * and the digest `approve` binds to. The whole body goes to the card: what the
 * owner cannot read, they cannot approve. The digest also covers what the card
 * cannot show as text (the stored HTML and blocks, attachment blobs, send-as
 * mailbox), so any change to what would go out changes it. `null` when there
 * is nothing to approve.
 */
export async function review(
	ctx: QueryCtx,
	row: Doc<'mcpPendingActions'>,
	isReachable: boolean
): Promise<{ details: McpActionDetails; reviewDigest: string | null }> {
	const { action } = row;
	if (!isReachable) return { details: INACCESSIBLE, reviewDigest: null };
	const thread = 'threadId' in action ? await ctx.db.get(action.threadId) : null;
	if (thread && thread.mailboxId !== row.mailboxId) {
		return { details: INACCESSIBLE, reviewDigest: null };
	}
	const base: ThreadBase = thread ? { threadSubject: thread.latestSubject } : {};
	const sealed = (details: McpActionDetails, sent: object = {}) => ({
		details,
		reviewDigest: sha256Hex(JSON.stringify({ action, details, sent })),
	});
	switch (action.tool) {
		case 'create_draft': {
			const original = action.inReplyToMessageId
				? await ctx.db.get(action.inReplyToMessageId)
				: null;
			return sealed({
				...base,
				to: action.to,
				cc: action.cc,
				subject: action.subject,
				body: action.body,
				...(original && original.mailboxId === row.mailboxId
					? { inReplyToSubject: original.subject }
					: {}),
			});
		}
		case 'send_draft': {
			const draft = await ctx.db.get(action.draftId);
			if (!draft || draft.mailboxId !== row.mailboxId) {
				return { details: { ...base, isDraftGone: true }, reviewDigest: null };
			}
			const opened = await openMailDraftBody(draft);
			const text =
				opened.bodyText ||
				(opened.bodyHtml ? htmlToPlainText(opened.bodyHtml, { preserveBreaks: true }) : '');
			return sealed(
				{
					...base,
					from: await fromIdentity(ctx, draft),
					to: draft.toAddresses,
					cc: draft.ccAddresses,
					bcc: draft.bccAddresses,
					subject: draft.subject,
					body: text,
					attachments: draft.attachments.map((file) => ({
						filename: file.filename,
						size: file.size,
						isInline: file.isInline,
					})),
				},
				{
					bodyHtml: opened.bodyHtml,
					bodyText: opened.bodyText,
					bodyBlocks: opened.bodyBlocks,
					composerMode: draft.composerMode,
					attachments: draft.attachments.map((file) => [
						file.storageId,
						file.contentType,
						file.contentId,
					]),
					sendAsMailboxId: draft.sendAsMailboxId,
					inReplyToMessageId: draft.inReplyToMessageId,
					isReadReceiptRequested: draft.isReadReceiptRequested,
				}
			);
		}
		case 'archive_thread':
			return sealed(base);
		case 'move_thread': {
			const folder = await ctx.db.get(action.folderId);
			return sealed({ ...base, ...(folder ? { folderName: folder.name } : {}) });
		}
		case 'label_thread': {
			const label = await ctx.db.get(action.labelId);
			return sealed({
				...base,
				isRemoval: !action.add,
				...(label ? { labelName: label.name } : {}),
			});
		}
	}
}
