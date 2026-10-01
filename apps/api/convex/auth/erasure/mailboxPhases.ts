/**
 * The member's personal mail — their external account credentials and every
 * PERSONAL mailbox with everything under it.
 *
 * Team inboxes and deliverability seeds the member connected are organization
 * infrastructure and are never touched here (`personalMailboxes`,
 * `isOrgInfrastructureAccount`): erasing one person must not brick the team's
 * inbox or orphan the org's placement probes.
 *
 * Order within the mailboxes: writers are stopped first (credentials, archive
 * imports, background jobs, and the mailbox is marked `deleted` so nothing
 * delivers into it), then mail, threads (with their catch-up cards and answer
 * uploads), drafts (with their ask sessions) and share links drain, then
 * the mailbox's small per-mailbox records, and last the folders, labels,
 * counters and the mailbox row itself. Every phase re-reads its range from the
 * start, so any of them resumes after a failed transaction.
 */

import type { Doc, Id, TableNames } from '../../_generated/dataModel';
import { drainEach, drainParents } from '../../contacts/erasure/phaseKit';
import { deleteBlobQuietly } from '../../lib/storageBlobs';
import { answerAskTargetKey } from '../../lib/validators/answerAsk';
import { mailThreadUploadKey } from '../../storage/uploads';
import { removeMessageAttachments } from '../../mail/attachmentIndex';
import { deleteMessageRowAndBlobs } from '../../mail/messagePurge';
import { deleteMailboxUsage } from '../../mail/mailboxUsage';
import { deleteFolderCounters, deleteMailboxCounters } from '../../mail/messageCounters';
import { isOrgInfrastructureAccount } from '../../mail/external/personalAccount';
import { deleteStoredAccessToken } from '../../mail/external/accessTokenStore';
import {
	deleteAskSession,
	deleteBlobAndReceipt,
	forEachPersonalMailbox,
	type MemberPhaseContext,
	type MemberPhaseRunner,
} from './phaseKit';

/**
 * Charged per message on top of the message row, for the reads the purge
 * helpers make that this module does not see: the mailbox and its usage row,
 * the unread counter buckets, the attachment index rows, the blob refcount
 * probes. The inline body is read and charged here separately.
 */
const MESSAGE_HELPER_BYTES = 8 * 1024;
/**
 * Rows a message counts for on top of its own. Those helpers read about a
 * dozen index ranges per message; weighting a message as four rows keeps a
 * full transaction near a hundred messages, well inside the platform's 4,096
 * index ranges per transaction.
 */
const MESSAGE_EXTRA_ROWS = 3;

type RangeReader = (limit: number) => Promise<Array<{ _id: Id<TableNames> }>>;

/** Delete every row of each range in turn. Returns whether all are empty. */
export async function deleteRanges(
	phase: MemberPhaseContext,
	readers: readonly RangeReader[]
): Promise<boolean> {
	for (const read of readers) {
		const isEmpty = await drainEach(phase.budget, read, (row) => phase.ctx.db.delete(row._id));
		if (!isEmpty) return false;
	}
	return true;
}

/**
 * External IMAP/SMTP accounts behind personal mailboxes: the encrypted
 * credentials, the cached OAuth access token, per-folder sync state, queued
 * write-backs (they carry the member's Message-IDs), import and move records.
 * Runs before the mailbox drains so the sync worker loses its credentials
 * rather than writing mail back into a mailbox that is being emptied.
 */
export const eraseExternalAccounts: MemberPhaseRunner = async (phase) => {
	const { ctx, budget, authUserId } = phase;
	const accounts = await ctx.db
		.query('externalMailAccounts')
		.withIndex('by_user', (q) => q.eq('userId', authUserId))
		.collect(); // bounded: a user connects a handful of accounts
	for (const account of accounts) {
		budget.chargeRead(account);
		if (await isOrgInfrastructureAccount(ctx, account)) continue; // org infrastructure — not personal data
		const accountId = account._id;
		const isDrained = await deleteRanges(phase, [
			(n) =>
				ctx.db
					.query('externalMailFolderSync')
					.withIndex('by_account', (q) => q.eq('accountId', accountId))
					.take(n),
			(n) =>
				ctx.db
					.query('externalMailRemoteOps')
					.withIndex('by_account_and_next_attempt', (q) => q.eq('accountId', accountId))
					.take(n),
			(n) =>
				ctx.db
					.query('mailboxMigrations')
					.withIndex('by_account', (q) => q.eq('accountId', accountId))
					.take(n),
			(n) =>
				ctx.db
					.query('mailboxMoves')
					.withIndex('by_account', (q) => q.eq('accountId', accountId))
					.take(n),
		]);
		if (!isDrained) return { isDone: false };
		await deleteStoredAccessToken(ctx, accountId);
		await ctx.db.delete(accountId);
		budget.chargeRows(1);
	}
	return { isDone: true };
};

/**
 * Stop everything that writes into a personal mailbox before its data goes:
 * mark it `deleted` (the soft-deleted state that address resolution, external
 * delivery and the archive importer treat as gone), and remove its archive
 * imports with their uploaded files, and its attachment, body-search and filter
 * backfill jobs. A running importer finds its job row gone at its next batch
 * and stops without writing.
 */
export const quiesceMailboxes: MemberPhaseRunner = (phase) =>
	forEachPersonalMailbox(phase, async (mailbox) => {
		const { ctx, budget } = phase;
		if (mailbox.status !== 'deleted') {
			await ctx.db.patch(mailbox._id, { status: 'deleted', updatedAt: Date.now() });
			budget.chargeRows(1);
		}
		const imports = await drainEach(
			budget,
			(n) =>
				ctx.db
					.query('mailArchiveImports')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
					.take(n),
			async (job) => {
				if (job.storageId) {
					await deleteBlobAndReceipt(phase, job.storageId, { archiveImportId: job._id });
				}
				await ctx.db.delete(job._id);
			}
		);
		if (!imports) return false;
		return deleteRanges(phase, [
			(n) =>
				ctx.db
					.query('mailAttachmentBackfillJobs')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailBodySearchBackfillJobs')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailFilterRunJobs')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
					.take(n),
		]);
	});

/**
 * Every message, with its attachment index rows, its inline body and the
 * storage blobs no other row still references (IMAP COPY shares blobs).
 */
export const eraseMessages: MemberPhaseRunner = (phase) =>
	forEachPersonalMailbox(phase, (mailbox) => {
		const { ctx, budget } = phase;
		return drainEach(
			budget,
			(n) =>
				ctx.db
					.query('mailMessages')
					.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailbox._id))
					.take(n),
			async (message) => {
				const body = await ctx.db
					.query('mailMessageBodies')
					.withIndex('by_message', (q) => q.eq('messageId', message._id))
					.first();
				// Read here and again by the purge helper.
				if (body) {
					budget.chargeRead(body);
					budget.chargeRead(body);
				}
				budget.chargeBytes(MESSAGE_HELPER_BYTES);
				budget.chargeRows(MESSAGE_EXTRA_ROWS);
				// The attachment index is a function of the message table, and this
				// walk deletes the mailbox too, so nothing would ever walk those rows
				// again: a junction row left behind keeps the correspondent's address
				// and the filename they sent.
				await removeMessageAttachments(ctx, message._id);
				await deleteMessageRowAndBlobs(ctx, message);
			}
		);
	});

/**
 * Conversation rows, each after what hangs off it: the cached Today summaries
 * and Answer mode catch-up cards (both retell the thread's content), and the
 * Reply Queue answer uploads bound to the thread (`mailThreadUploadKey`). A
 * mailbox that kept its threads after its messages drained can hold far more
 * than one transaction may read; they go one at a time within the budget. A
 * thread whose children outlast the budget stays, and the phase is not done
 * until the next transaction, which starts with it.
 */
export const eraseThreads: MemberPhaseRunner = (phase) =>
	forEachPersonalMailbox(phase, async (mailbox) => {
		const { ctx, budget } = phase;
		const outcome = await drainParents(
			budget,
			() =>
				ctx.db
					.query('mailThreads')
					.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailbox._id))
					.first(),
			async (thread: Doc<'mailThreads'>) => {
				const isEmpty = await deleteRanges(phase, [
					(n) =>
						ctx.db
							.query('todayThreadSummaries')
							.withIndex('by_thread_locale_counts', (q) => q.eq('threadId', thread._id))
							.take(n),
					(n) =>
						ctx.db
							.query('threadCatchUps')
							.withIndex('by_mail_thread_and_locale', (q) => q.eq('mailThreadId', thread._id))
							.take(n),
				]);
				if (!isEmpty) return false;
				const resourceKey = mailThreadUploadKey(thread._id);
				const isUploadsEmpty = await drainEach(
					budget,
					(n) =>
						ctx.db
							.query('storageUploads')
							.withIndex('by_resource', (q) => q.eq('resourceKey', resourceKey))
							.take(n),
					async (receipt) => {
						// As `storage/uploads.deleteResourceUploads`: only a bound
						// receipt is deletion authority for its blob.
						if (receipt.storageId && receipt.status === 'bound') {
							await deleteBlobQuietly(ctx.storage, receipt.storageId, '[member erasure]', {
								threadId: thread._id,
							});
						}
						await ctx.db.delete(receipt._id);
					}
				);
				if (!isUploadsEmpty) return false;
				await ctx.db.delete(thread._id);
				return true;
			}
		);
		return outcome.isDone;
	});

/**
 * Drafts, each after the Answer mode ask sessions started on it (whoever
 * started them, with their draft streams), then with the attachment files it
 * holds.
 */
export const eraseDrafts: MemberPhaseRunner = (phase) =>
	forEachPersonalMailbox(phase, async (mailbox) => {
		const { ctx, budget } = phase;
		const outcome = await drainParents(
			budget,
			() =>
				ctx.db
					.query('mailDrafts')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
					.first(),
			async (draft: Doc<'mailDrafts'>) => {
				const targetKey = answerAskTargetKey({ kind: 'mailDraft', draftId: draft._id });
				const isSessionsEmpty = await drainEach(
					budget,
					(n) =>
						ctx.db
							.query('answerAskSessions')
							.withIndex('by_target_owner', (q) => q.eq('targetKey', targetKey))
							.take(n),
					(session) => deleteAskSession(phase, session)
				);
				if (!isSessionsEmpty) return false;
				for (const attachment of draft.attachments) {
					await deleteBlobAndReceipt(phase, attachment.storageId, { draftId: draft._id });
					budget.chargeRows(1);
				}
				await ctx.db.delete(draft._id);
				return true;
			}
		);
		return outcome.isDone;
	});

/** Attachment share links out of the mailbox, with the file each one serves. */
export const eraseShares: MemberPhaseRunner = (phase) =>
	forEachPersonalMailbox(phase, (mailbox) => {
		const { ctx, budget } = phase;
		return drainEach(
			budget,
			(n) =>
				ctx.db
					.query('mailAttachmentShares')
					.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', mailbox._id))
					.take(n),
			async (share) => {
				if (share.storageId) {
					await deleteBlobAndReceipt(phase, share.storageId, { shareId: share._id });
				}
				await ctx.db.delete(share._id);
			}
		);
	});

/**
 * The mailbox's own records: rules, signatures, snippets, learned style, the
 * AI digests and commitments, saved searches, forwarding and vacation state,
 * the private address book and per-sender preferences, app passwords, aliases,
 * pending and current member grants, and any attachment index row a message
 * delete left behind.
 */
export const eraseMailboxRecords: MemberPhaseRunner = (phase) =>
	forEachPersonalMailbox(phase, (mailbox) => {
		const { ctx } = phase;
		const id = mailbox._id;
		return deleteRanges(phase, [
			(n) =>
				ctx.db
					.query('mailFilters')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailSignatures')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailSnippets')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailVoiceProfiles')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailContactStyleOverrides')
					.withIndex('by_mailbox_and_address', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailCommitments')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailDailyBriefs')
					.withIndex('by_mailbox_and_generated', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailBriefCards')
					.withIndex('by_mailbox_and_user', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailSavedSearches')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailForwarding')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailVacationResponders')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailVacationLog')
					.withIndex('by_mailbox_and_sender', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailContacts')
					.withIndex('by_mailbox_and_email', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailSenderCategoryOverrides')
					.withIndex('by_mailbox_and_sender', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailSenderImageAllowlist')
					.withIndex('by_mailbox_and_sender', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailTriageTallies')
					.withIndex('by_mailbox_and_sender', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailAppPasswords')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailAliases')
					.withIndex('by_target', (q) => q.eq('targetMailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('pendingMailboxMembers')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailboxMembers')
					.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('mailAttachments')
					.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', id))
					.take(n),
		]);
	});

/** Folders (with their counter scopes), labels, usage, counters, the mailbox row. */
export const eraseMailboxRows: MemberPhaseRunner = (phase) =>
	forEachPersonalMailbox(phase, async (mailbox) => {
		const { ctx, budget } = phase;
		const isFoldersEmpty = await drainEach(
			budget,
			(n) =>
				ctx.db
					.query('mailFolders')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
					.take(n),
			async (folder) => {
				await deleteFolderCounters(ctx, folder._id);
				await ctx.db.delete(folder._id);
			}
		);
		if (!isFoldersEmpty) return false;
		const isLabelsEmpty = await deleteRanges(phase, [
			(n) =>
				ctx.db
					.query('mailLabels')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
					.take(n),
		]);
		if (!isLabelsEmpty) return false;
		await deleteMailboxUsage(ctx, mailbox._id);
		await deleteMailboxCounters(ctx, mailbox._id);
		await ctx.db.delete(mailbox._id);
		budget.chargeRows(1);
		return true;
	});
