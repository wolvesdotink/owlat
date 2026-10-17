/**
 * Sender status and counters at delivery (SPEC §5): the implementations
 * behind the `applySenderStatusAtDelivery` and `recordSenderDelivery` hooks
 * (`mail/arrival/hooks.ts`), plus the record stamp that ties them together.
 *
 * THE SEAM. Hosted MX enforcement runs BEFORE the insert (right after
 * `resolveFilterOutcome`), so there is no message row and no arrival record
 * yet. `mail/delivery.ts` keeps the hook's outcome in a local and, after
 * `runPostInsertInboundEffects` (where lane arrival writes the arrival record),
 * calls {@link settleSenderDelivery} with it. External sync enforces after the
 * insert and settles at the same point. `settleSenderDelivery` counts the
 * delivery and stamps the outcome on the record: `exclusiveWinners.folder`
 * (source `sender_status`, the top priority) and one reason key. When the
 * record does not exist (a team inbox, or arrival's write moved), the stamp is
 * skipped; the enforced archive itself never depends on it. The enforced
 * archive is not an operation: it is the steady-state effect of a status that
 * has its own.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { ReasonKey, SenderStatus } from '@owlat/shared/arrival';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { InboundOrigin } from '../deliveryPipeline/insert';
import { FolderFlagWrites, writeMessageFlags } from '../flagWrites';
import { moveMessagesToFolder } from '../messageActions';
import { isFromMailboxOwner } from '../needsReplyHeuristic';
import { isPersonalMailbox } from '../permissions';
import { applyThreadFlagDeltas, type ThreadFlagDeltas } from '../threadAggregates';
import { recordRemoteChanges } from '../external/remoteOps';
import { addSenderDelivery } from './counters';
import { ensureSenderProfile, loadSenderProfile, senderKeyOf } from './profiles';

/** Sender status beats every filter priority in `exclusiveWinners` (§6.2). */
export const SENDER_STATUS_WINNER_PRIORITY = Number.MAX_SAFE_INTEGER;

/** The reason key an enforced archive leaves on the arrival record. */
export const SENDER_STATUS_REASON_KEY = 'arrival.reason.senderStatus';

/** Folders whose mail was never delivered to the person (§5 counts live inbound only). */
const UNCOUNTED_ROLES: ReadonlySet<string> = new Set(['spam', 'trash', 'sent', 'drafts']);

export interface SenderStatusInput {
	mailboxId: Id<'mailboxes'>;
	fromAddress: string;
	origin: Exclude<InboundOrigin, 'backfill'>;
	isMovedByFilter: boolean;
	messageId?: Id<'mailMessages'>;
}

export type SenderStatusOutcome = { status: SenderStatus; filedTo?: 'archive' } | null;

async function folderByRole(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	role: 'inbox' | 'archive'
): Promise<Doc<'mailFolders'> | null> {
	return await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', role))
		.first();
}

/** Mark one message read with the folder, thread and provider bookkeeping a person's mark-read gets. */
async function markDeliveredRead(ctx: MutationCtx, message: Doc<'mailMessages'>): Promise<void> {
	const folders = new FolderFlagWrites(ctx);
	const threads: ThreadFlagDeltas = new Map();
	const change = await writeMessageFlags(ctx, folders, threads, message, { seen: true });
	await folders.flush();
	await applyThreadFlagDeltas(ctx, threads);
	if (change) await recordRemoteChanges(ctx, [change]);
}

/**
 * `unsubscribed` → Archive, `auto_archive` → Archive and read, `digest` →
 * stays (placement does the rest). A filter that already moved, trashed or
 * quarantined the message wins, and so does a muted thread's own routing.
 *
 * Hosted (no `messageId`): decides only; the caller files into Archive and
 * sets `flagSeen`. External (`messageId`): moves the inserted row through
 * `moveMessagesToFolder`, which writes the move back to the provider.
 */
export async function applySenderStatus(
	ctx: MutationCtx,
	input: SenderStatusInput
): Promise<SenderStatusOutcome> {
	if (input.isMovedByFilter) return null;
	const mailbox = await ctx.db.get(input.mailboxId);
	if (!mailbox || !isPersonalMailbox(mailbox)) return null;
	const profile = await loadSenderProfile(
		ctx,
		mailbox._id,
		senderKeyOf(input.fromAddress).senderDigest
	);
	if (!profile || profile.status === 'keep') return null;
	if (profile.status === 'digest') return { status: 'digest' };

	const archive = await folderByRole(ctx, mailbox._id, 'archive');
	// No Archive folder: delivering to the Inbox beats refusing the mail.
	if (!archive) return { status: profile.status };
	if (!input.messageId) return { status: profile.status, filedTo: 'archive' };

	const message = await ctx.db.get(input.messageId);
	const inbox = await folderByRole(ctx, mailbox._id, 'inbox');
	// A muted thread's delivery was already re-routed inside the insert.
	if (!message || !inbox || message.folderId !== inbox._id) return { status: profile.status };
	if (profile.status === 'auto_archive' && !message.flagSeen) await markDeliveredRead(ctx, message);
	await moveMessagesToFolder(ctx, { messageIds: [message._id], targetFolderId: archive._id });
	return { status: profile.status, filedTo: 'archive' };
}

/**
 * Count a live delivery (§5): the sender's delivered week, display name,
 * last delivery and kind. Marks the row `isOpenCounted: false`, which is the
 * cohort marker: only mail counted here can later count as opened.
 */
export async function countSenderDelivery(
	ctx: MutationCtx,
	args: { message: Doc<'mailMessages'>; origin: InboundOrigin }
): Promise<void> {
	const { message } = args;
	if (args.origin === 'backfill' || message.isOpenCounted !== undefined) return;
	const mailbox = await ctx.db.get(message.mailboxId);
	if (!mailbox || !isPersonalMailbox(mailbox)) return;
	if (isFromMailboxOwner(message, mailbox.address)) return;
	const folder = await ctx.db.get(message.folderId);
	if (!folder || (folder.role !== undefined && UNCOUNTED_ROLES.has(folder.role))) return;

	const deliveredAt = message._creationTime;
	const profile = await ensureSenderProfile(ctx, {
		mailboxId: mailbox._id,
		address: message.fromAddress,
		displayName: message.fromName,
		now: deliveredAt,
	});
	const thread = await ctx.db.get(message.threadId);
	const kind = thread?.category?.label ?? profile.kind;
	await ctx.db.patch(profile._id, {
		...addSenderDelivery(profile, deliveredAt),
		lastDeliveredAt: deliveredAt,
		...(message.fromName ? { displayName: message.fromName } : {}),
		...(kind ? { kind } : {}),
		updatedAt: Date.now(),
	});
	await ctx.db.patch(message._id, { isOpenCounted: false });
}

/**
 * Stamp an enforced archive on the message's arrival record. Returns false
 * when there is nothing to stamp (no archive, or no record).
 */
export async function stampSenderStatusOnRecord(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>,
	outcome: SenderStatusOutcome
): Promise<boolean> {
	if (!outcome?.filedTo) return false;
	const record = await ctx.db
		.query('mailArrivalRecords')
		.withIndex('by_message', (q) => q.eq('messageId', messageId))
		.first();
	if (!record) return false;
	const reason: ReasonKey = { key: SENDER_STATUS_REASON_KEY, params: { status: outcome.status } };
	const reasonKeys = record.reasonKeys.some((key) => key.key === SENDER_STATUS_REASON_KEY)
		? record.reasonKeys
		: [...record.reasonKeys, reason];
	await ctx.db.patch(record._id, {
		exclusiveWinners: {
			...record.exclusiveWinners,
			folder: { source: 'sender_status', priority: SENDER_STATUS_WINNER_PRIORITY },
		},
		reasonKeys,
		updatedAt: Date.now(),
	});
	return true;
}

/**
 * The post-insert half, called by both live-ingest paths after
 * `runPostInsertInboundEffects`: count the delivery, then stamp the outcome.
 */
export async function settleSenderDelivery(
	ctx: MutationCtx,
	args: {
		messageId: Id<'mailMessages'>;
		origin: InboundOrigin;
		senderStatus: SenderStatusOutcome;
	}
): Promise<void> {
	const message = await ctx.db.get(args.messageId);
	if (!message) return;
	await countSenderDelivery(ctx, { message, origin: args.origin });
	await stampSenderStatusOnRecord(ctx, message._id, args.senderStatus);
}
