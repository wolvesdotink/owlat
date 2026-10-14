/**
 * Resolve who may read captured mail attachments and what was learned from
 * them (migration 0069, #1322).
 *
 *   npx convex run migrations/0069_restrict_captured_file_knowledge:run
 *
 * READS ARE ALREADY SAFE BEFORE THIS RUNS. A file captured from inbound mail
 * keeps its mailbox's permission from the deploy on (lib/semanticFileAccess.ts),
 * and knowledge from ANY file stays with the shared-inbox readers until it is
 * proven to come from an upload (inbox/access.ts `isInboxDerivedKnowledge`).
 * This walk gives back what it can prove, and restricts what it cannot:
 *
 *   1. `files`, every Files row. A capture whose source is not recorded — one
 *      stored before `captureSource` existed (only `sourceType:
 *      'email_attachment'`), or a Postbox one stored before its mailbox was —
 *      is matched by its Message-ID. Found in the Team Inbox only, it becomes
 *      `team_inbox`; found in exactly one mailbox only, it becomes that
 *      mailbox's. Anything else stays as it is: readable by owners and admins.
 *      Then, for every contact the capture is linked to, MERGE SUSPECTS are
 *      restricted (below).
 *   2. `knowledge`, every entry from a file (`by_source`). Its file is an
 *      upload ⇒ `memberAccess: 'members'` (members see it again). A capture, or
 *      a file that is gone ⇒ `restricted`, and its contacts' merge suspects too.
 *
 * MERGE SUSPECTS. Before this release an entry learned from a capture was
 * member-visible, so the daily dedup (knowledge/maintenance.ts) could fold its
 * content into a member-visible survivor and delete it, leaving no trace of
 * where the text came from. A merge only happens between entries linked to one
 * contact, within the first `DEDUP_MAX_ENTRIES_PER_CONTACT` links, and appends
 * the loser's content on a new line (lib/knowledgeDedup.ts `mergeContent`). So
 * every member-visible entry in that window of such a contact whose content
 * has more than one line is restricted. That also catches multi-line entries
 * no merge touched; failing closed is the point. An owner or admin still sees
 * them all.
 *
 * DURABLE AND RESUMABLE: progress and completion live in the migration ledger
 * (`migrationRuns` row `0069_restrict_captured_file_knowledge`,
 * lib/migrationLedger.ts); the cursor carries its pass as a prefix. Running
 * `run` again on an unfinished walk resumes it; on a finished one it does
 * nothing (`'{"restart":true}'` starts over, and is what to run again if an
 * extraction from the previous release stored knowledge from an upload after
 * the walk had passed it). Pages are idempotent.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { logInfo } from '../lib/runtimeLog';
import { canonicalMessageId } from '../lib/messageId';
import { isMailCapture } from '../lib/semanticFileAccess';
import { resolveMemberAccess } from '../knowledge/entryDedupe';
import { DEDUP_MAX_ENTRIES_PER_CONTACT } from '../knowledge/maintenance';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
} from '../lib/migrationLedger';

export const MIGRATION = '0069_restrict_captured_file_knowledge';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.13';
/** Rows per page; a capture can read up to a merge window per contact. */
const PAGE_SIZE = 20;
/** Messages read per Message-ID when matching a capture to its mailbox. */
const MATCH_LIMIT = 10;

type Pass = 'files' | 'knowledge';

/** The ledger cursor: `<pass>:<convex cursor>`, an empty cursor for a pass's first page. */
export function encodeCursor(pass: Pass, cursor: string | null): string {
	return `${pass}:${cursor ?? ''}`;
}

export function decodeCursor(stored: string | null | undefined): {
	pass: Pass;
	cursor: string | null;
} {
	if (!stored) return { pass: 'files', cursor: null };
	const split = stored.indexOf(':');
	const pass = stored.slice(0, split) === 'knowledge' ? 'knowledge' : 'files';
	const cursor = split === -1 ? null : stored.slice(split + 1);
	return { pass, cursor: cursor || null };
}

/** Whether an entry's content could hold a merged-in loser (`mergeContent` appends on a new line). */
export function couldHoldMergedContent(entry: Pick<Doc<'knowledgeEntries'>, 'content'>): boolean {
	return entry.content.includes('\n');
}

/**
 * Where an unrecorded capture came from, by its Message-ID: the Team Inbox,
 * one mailbox, or null when that is not one place.
 */
async function matchCaptureSource(
	ctx: MutationCtx,
	messageId: string
): Promise<Pick<Doc<'semanticFiles'>, 'captureSource' | 'sourceMailboxId'> | null> {
	const canonical = canonicalMessageId(messageId);
	const mailboxIds = new Set<Id<'mailboxes'>>();
	for (const id of new Set([messageId, canonical])) {
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_rfc822_message_id', (q) => q.eq('rfc822MessageId', id))
			.take(MATCH_LIMIT);
		for (const message of messages) mailboxIds.add(message.mailboxId);
	}
	let isInTeamInbox = false;
	for (const id of new Set([messageId, canonical])) {
		const inbound = await ctx.db
			.query('inboundMessages')
			.withIndex('by_message_id', (q) => q.eq('messageId', id))
			.first();
		isInTeamInbox ||= inbound !== null;
	}
	if (isInTeamInbox) return mailboxIds.size === 0 ? { captureSource: 'team_inbox' } : null;
	const [only, ...rest] = mailboxIds;
	return only && rest.length === 0 ? { captureSource: 'mailbox', sourceMailboxId: only } : null;
}

/** Restrict every member-visible entry of `contactId` a historical merge could have reached. */
async function restrictMergeSuspects(ctx: MutationCtx, contactId: Id<'contacts'>): Promise<number> {
	const links = await ctx.db
		.query('knowledgeEntryContacts')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.take(DEDUP_MAX_ENTRIES_PER_CONTACT);
	let changed = 0;
	for (const link of links) {
		const entry = await ctx.db.get(link.entryId);
		if (!entry || entry.memberAccess === 'restricted' || !couldHoldMergedContent(entry)) continue;
		await ctx.db.patch(entry._id, { memberAccess: 'restricted' });
		changed++;
	}
	return changed;
}

async function filesPage(ctx: MutationCtx, cursor: string | null) {
	const result = await ctx.db.query('semanticFiles').paginate({ numItems: PAGE_SIZE, cursor });
	let changed = 0;
	for (const file of result.page) {
		if (!isMailCapture(file)) continue;
		const isRecorded =
			file.captureSource === 'team_inbox' ||
			(file.captureSource === 'mailbox' && file.sourceMailboxId !== undefined);
		if (!isRecorded && file.sourceMessageId) {
			const match = await matchCaptureSource(ctx, file.sourceMessageId);
			if (match && (!file.captureSource || match.captureSource === file.captureSource)) {
				await ctx.db.patch(file._id, match);
				changed++;
			}
		}
		for (const contactId of new Set(file.contactIds ?? [])) {
			changed += await restrictMergeSuspects(ctx, contactId);
		}
	}
	return { ...result, scanned: result.page.length, changed };
}

async function knowledgePage(ctx: MutationCtx, cursor: string | null) {
	const result = await ctx.db
		.query('knowledgeEntries')
		.withIndex('by_source', (q) => q.eq('sourceType', 'file'))
		.paginate({ numItems: PAGE_SIZE, cursor });
	let changed = 0;
	for (const entry of result.page) {
		if (entry.memberAccess === 'restricted') continue;
		const access = await resolveMemberAccess(ctx, entry);
		if (access === 'members') {
			if (entry.memberAccess !== 'members') {
				await ctx.db.patch(entry._id, { memberAccess: 'members' });
				changed++;
			}
			continue;
		}
		await ctx.db.patch(entry._id, { memberAccess: 'restricted' });
		changed++;
		for (const contactId of new Set(entry.contactIds ?? [])) {
			changed += await restrictMergeSuspects(ctx, contactId);
		}
	}
	return { ...result, scanned: result.page.length, changed };
}

/** Run one page of the current pass and schedule the next one of the same run. */
export const processPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
	handler: async (ctx, args): Promise<{ isDone: boolean; isSuperseded?: boolean }> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0069_restrict_captured_file_knowledge.superseded', {
				generation: args.generation,
			});
			return { isDone: false, isSuperseded: true };
		}
		const { pass, cursor } = decodeCursor(args.cursor);
		const result =
			pass === 'files' ? await filesPage(ctx, cursor) : await knowledgePage(ctx, cursor);
		const next =
			pass === 'files' && result.isDone
				? encodeCursor('knowledge', null)
				: encodeCursor(pass, result.continueCursor);
		const isDone = pass === 'knowledge' && result.isDone;
		await recordMigrationPage(ctx, run, {
			cursor: next,
			isDone,
			scanned: result.scanned,
			changed: result.changed,
		});
		logInfo('migration.0069_restrict_captured_file_knowledge.page', {
			pass,
			scanned: result.scanned,
			changed: result.changed,
			isDone,
			generation: run.generation,
		});
		if (!isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations['0069_restrict_captured_file_knowledge'].processPage,
				{ cursor: next, generation: run.generation }
			);
		}
		return { isDone };
	},
});

/**
 * Start the background walk, or resume an unfinished one from its recorded
 * cursor (or from `cursor` when given). A finished migration is left alone
 * unless `restart` is set.
 */
export const run = internalMutation({
	args: {
		cursor: v.optional(v.union(v.string(), v.null())),
		restart: v.optional(v.boolean()),
	},
	handler: async (
		ctx,
		args
	): Promise<{ started: boolean; generation?: number; reason?: string }> => {
		const begun = await beginMigrationRun(ctx, {
			migration: MIGRATION,
			introducedIn: INTRODUCED_IN,
			cursor: args.cursor,
			restart: args.restart,
		});
		if (!begun) {
			return { started: false, reason: 'Already completed; pass restart to run it again' };
		}
		await ctx.scheduler.runAfter(
			0,
			internal.migrations['0069_restrict_captured_file_knowledge'].processPage,
			{ cursor: begun.cursor ?? null, generation: begun.generation }
		);
		logInfo('migration.0069_restrict_captured_file_knowledge.started', {
			cursor: begun.cursor ?? null,
			generation: begun.generation,
		});
		return { started: true, generation: begun.generation };
	},
});
