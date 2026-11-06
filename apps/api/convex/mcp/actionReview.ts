/**
 * What the owner reviews before approving an MCP action, and the digest that
 * binds the approval to it (`approve`, `getReview` and `listPending` in
 * `mcp/actions.ts`).
 *
 * Not a Convex function module.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { htmlToPlainText } from '@owlat/shared/html';
import { openMailDraftBody } from '../lib/messageBody';
import { sha256Hex } from '../lib/aiRouting/routeDigest';
import type { MailApprovedSend } from '../lib/validators/mailContent';
import { renderOutgoingBodies, threadingHeaders } from '../mail/outbound/derive';
import { loadSealInputs } from '../mail/outboundQueries';
import {
	decideSeal,
	sealOutcomeOf,
	type SealOutcome,
	type SealSkipReason,
} from '../mail/sealPolicy';
import { resolveMcpAccess } from './access';
import { hasHiddenContent } from './reviewHiddenContent';
import { reviewLinks, type ReviewLink } from './reviewLinks';

/** Characters of a drafted body the approval list shows before the card opens. */
const SUMMARY_PREVIEW_MAX = 160;

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
			/**
			 * The HTML part as it goes out, unsanitized. The card renders it only
			 * through the reader's sanitizer in a sandboxed frame that loads nothing
			 * remote, so the owner sees what the recipient sees, hidden text included.
			 */
			html: string;
			/** Every link of every part, with its real target. */
			links: ReviewLink[];
			/**
			 * Whether some of the HTML part shows only in some clients, modes or
			 * screen sizes, which the preview cannot show (`reviewHiddenContent.ts`).
			 */
			hasHiddenContent: boolean;
			/** The HTML part as text: every line of it, hidden or not, shown beside the preview. */
			body: string;
			/** The text/plain part, when it says something else than the HTML part. */
			plainTextBody?: string;
			/**
			 * The AMP part as text, when the send has one and it says something else
			 * than the HTML part: AMP-capable clients show it instead.
			 */
			ampBody?: string;
			inReplyToSubject?: string;
			sealing: { isSealed: true } | { isSealed: false; reason: SealSkipReason };
			attachments: Array<{ filename: string; size: number; isInline: boolean }>;
	  })
	| (ThreadBase & { folderName?: string })
	| (ThreadBase & { isRemoval: boolean; labelName?: string });

/** What the approval list shows of an action before its card loads the review. */
export type McpActionSummary =
	| typeof INACCESSIBLE
	| (ThreadBase & {
			subject?: string;
			firstRecipient?: string;
			recipientCount?: number;
			preview?: string;
			isRemoval?: boolean;
	  });

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
 * What dispatch will derive for this draft's send, computed the way dispatch
 * computes it: the bodies through its renderer, the threading headers from
 * the live reply target, and the sealing from its seal decision on the
 * current key state. The review shows and digests these, and the approval run
 * binds the threading and sealing to the send (`approvedSendOf`).
 */
export async function sendInputs(ctx: QueryCtx, draft: Doc<'mailDrafts'>) {
	const opened = await openMailDraftBody(draft);
	const rendered = renderOutgoingBodies(opened);
	const original = draft.inReplyToMessageId ? await ctx.db.get(draft.inReplyToMessageId) : null;
	const sealInputs = await loadSealInputs(ctx, draft.fromAddress, [
		...draft.toAddresses,
		...draft.ccAddresses,
		...draft.bccAddresses,
	]);
	return {
		rendered,
		original,
		threading: threadingHeaders(original),
		sealing: sealOutcomeOf(decideSeal(sealInputs)),
	};
}

/** The part of a send's inputs that dispatch reads again later, as the approval binds it. */
export function approvedSendOf(
	inputs: Pick<Awaited<ReturnType<typeof sendInputs>>, 'threading' | 'sealing'>
): MailApprovedSend {
	return {
		...inputs.threading,
		sealing: inputs.sealing.isSealed
			? { isSealed: true, keysDigest: inputs.sealing.keysDigest }
			: { isSealed: false },
	};
}

/** The sealing as the card states it; which keys stays in the digest. */
function shownSealing(sealing: SealOutcome) {
	return sealing.isSealed
		? { isSealed: true as const }
		: { isSealed: false as const, reason: sealing.reason };
}

const sameText = (a: string, b: string) =>
	a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/**
 * What the approval card shows for one action, the live names behind its ids,
 * and the digest `approve` binds to. The whole body goes to the card: what the
 * owner cannot read, they cannot approve. For a send the body is what dispatch
 * renders: its HTML part to preview as the recipient sees it, every link with
 * its real target, whether some of it is hidden from some recipients, and the
 * parts as text. The digest covers the rendered parts, the threading headers
 * and the sealing (to which keys), so any change to what would go out changes
 * it.
 * `null` when there is nothing to approve.
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
			const inputs = await sendInputs(ctx, draft);
			const body = htmlToPlainText(inputs.rendered.html, { preserveBreaks: true });
			const ampBody = inputs.rendered.amp
				? htmlToPlainText(inputs.rendered.amp, { preserveBreaks: true })
				: undefined;
			return sealed(
				{
					...base,
					from: await fromIdentity(ctx, draft),
					to: draft.toAddresses,
					cc: draft.ccAddresses,
					bcc: draft.bccAddresses,
					subject: draft.subject,
					html: inputs.rendered.html,
					links: reviewLinks(inputs.rendered),
					hasHiddenContent: hasHiddenContent(inputs.rendered.html),
					body,
					...(sameText(body, inputs.rendered.text) ? {} : { plainTextBody: inputs.rendered.text }),
					...(ampBody !== undefined && !sameText(body, ampBody) ? { ampBody } : {}),
					...(inputs.original && inputs.original.mailboxId === row.mailboxId
						? { inReplyToSubject: inputs.original.subject }
						: {}),
					sealing: shownSealing(inputs.sealing),
					attachments: draft.attachments.map((file) => ({
						filename: file.filename,
						size: file.size,
						isInline: file.isInline,
					})),
				},
				{
					rendered: inputs.rendered,
					threading: inputs.threading,
					sealing: inputs.sealing,
					attachments: draft.attachments.map((file) => [
						file.storageId,
						file.contentType,
						file.contentId,
					]),
					sendAsMailboxId: draft.sendAsMailboxId,
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

/**
 * What the approval list shows of one action, from the pending row and its
 * conversation alone. A send's draft is not read here: its body may be large,
 * and the list reads up to fifty actions in one query. The card loads the
 * full review (`review`) when it opens.
 */
export async function summarize(
	ctx: QueryCtx,
	row: Doc<'mcpPendingActions'>,
	isReachable: boolean
): Promise<McpActionSummary> {
	const { action } = row;
	if (!isReachable) return INACCESSIBLE;
	const thread = 'threadId' in action ? await ctx.db.get(action.threadId) : null;
	if (thread && thread.mailboxId !== row.mailboxId) return INACCESSIBLE;
	const base: ThreadBase = thread ? { threadSubject: thread.latestSubject } : {};
	switch (action.tool) {
		case 'create_draft':
			return {
				...base,
				subject: action.subject,
				...(action.to[0] ? { firstRecipient: action.to[0] } : {}),
				recipientCount: action.to.length + action.cc.length,
				preview: action.body.slice(0, SUMMARY_PREVIEW_MAX),
			};
		case 'label_thread':
			return { ...base, isRemoval: !action.add };
		case 'send_draft':
		case 'archive_thread':
		case 'move_thread':
			return base;
	}
}
