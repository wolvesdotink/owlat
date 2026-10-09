/**
 * Interpreting mail that arrived before the thread brief did (ADR-0072, D5):
 * the 30-day backfill walk (`backfill.ts`) and the first open of an older
 * thread (`lazy.ts`) both hand a thread's newest messages to interpretation
 * through {@link enqueueThreadInterpretation}.
 *
 * Each picked message gets its eligibility snapshot (`sources.ts`) and one
 * scheduled `interpretMessage` run, spaced out so a page of threads does not
 * land as one burst. The snapshot is taken as `isLive: true`: the delivery
 * path's `not_live` rule keeps a history import from being read on arrival,
 * and these messages were admitted on purpose (an active thread, or one the
 * reader opened). Folder, mute and bulk rules still apply in the run.
 *
 * What it never does: notify anyone, or put a thread back in the Reply Queue.
 * `interpretMessage` only writes the brief (items, facts, activity) and its
 * list projection; the needs-reply decision is the delivery classify's, which
 * does not run here.
 *
 * A message that already has a snapshot is left alone (live delivery or an
 * earlier backfill took it), which makes both callers idempotent.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { InterpretationSource } from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { markBriefPending } from './briefRow';
import { captureInterpretSource, loadInterpretSource } from './sources';

/** Newest messages of one thread handed to interpretation. */
export const MESSAGES_PER_THREAD = 4;
/** Spacing between scheduled runs. */
export const RUN_SPACING_MS = 1_500;

/** Folder roles a thread can sit in and still be "active" (D5). */
const INACTIVE_ROLES: ReadonlySet<string> = new Set(['archive', 'trash', 'spam', 'junk']);
/** Folders whose messages are never picked. */
const SKIPPED_ROLES: ReadonlySet<string> = new Set(['trash', 'spam', 'junk', 'drafts']);

/**
 * An active thread (D5): not muted, not the Daily Brief's own mail, and not
 * archived or trashed (in the inbox, or in no archive/trash/spam folder at
 * all, which keeps threads that live only in Sent or a custom folder). Pure.
 */
export function isActiveThread(
	thread: Pick<Doc<'mailThreads'>, 'folderRoles' | 'mutedAt' | 'isSelfDeliveredBrief'>
): boolean {
	if (thread.mutedAt !== undefined || thread.isSelfDeliveredBrief) return false;
	if (thread.folderRoles.includes('inbox')) return true;
	return !thread.folderRoles.some((role) => INACTIVE_ROLES.has(role));
}

/**
 * The source a stored Postbox message is interpreted as: our own sent mail is
 * `outboundMail` (the folder rule skips it), everything else `mail`. Pure.
 */
export function mailSourceOf(
	message: Pick<Doc<'mailMessages'>, '_id' | 'outbound' | 'sentByUserId'>,
	folderRole: string | undefined
): InterpretationSource {
	const isOurs =
		message.outbound !== undefined || message.sentByUserId !== undefined || folderRole === 'sent';
	return { kind: isOurs ? 'outboundMail' : 'mail', id: message._id };
}

/** Whether either source kind of a Postbox message already has a snapshot. */
async function isMailMessageTaken(ctx: MutationCtx, id: Id<'mailMessages'>): Promise<boolean> {
	const [asMail, asOutbound] = await Promise.all([
		loadInterpretSource(ctx, { kind: 'mail', id }),
		loadInterpretSource(ctx, { kind: 'outboundMail', id }),
	]);
	return asMail !== null || asOutbound !== null;
}

/**
 * The thread's newest `limit` messages (drafts aside) that are not taken yet,
 * oldest first. Only the newest `limit` are ever considered, so a second walk
 * over a thread finds nothing new instead of digging further back.
 */
async function pickMailSources(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	limit: number
): Promise<InterpretationSource[]> {
	const recent = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread_and_received', (q) => q.eq('threadId', threadId))
		.order('desc')
		.take(limit * 2);
	const picked: InterpretationSource[] = [];
	for (const message of recent.filter((m) => !m.flagDraft).slice(0, limit)) {
		const folder = await ctx.db.get(message.folderId);
		if (folder?.role && SKIPPED_ROLES.has(folder.role)) continue;
		if (await isMailMessageTaken(ctx, message._id)) continue;
		picked.push(mailSourceOf(message, folder?.role));
	}
	return picked.reverse();
}

/** The newest `limit` inbound messages of a Team Inbox thread not yet taken, oldest first. */
async function pickTeamSources(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	limit: number
): Promise<InterpretationSource[]> {
	const recent = await ctx.db
		.query('inboundMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.order('desc')
		.take(limit);
	const picked: InterpretationSource[] = [];
	for (const message of recent) {
		const source = { kind: 'inbound' as const, id: message._id };
		if (await loadInterpretSource(ctx, source)) continue;
		picked.push(source);
	}
	return picked.reverse();
}

/**
 * Snapshot and schedule the thread's newest untaken messages, the first run
 * `startDelayMs` from now and the rest {@link RUN_SPACING_MS} apart, and mark
 * the brief pending when anything was scheduled. Returns how many runs were
 * scheduled.
 */
export async function enqueueThreadInterpretation(
	ctx: MutationCtx,
	ref: ThreadRef,
	opts: { limit?: number; startDelayMs?: number } = {}
): Promise<number> {
	const limit = opts.limit ?? MESSAGES_PER_THREAD;
	const sources =
		ref.kind === 'mail'
			? await pickMailSources(ctx, ref.id, limit)
			: await pickTeamSources(ctx, ref.id, limit);
	let scheduled = 0;
	for (const source of sources) {
		if (!(await captureInterpretSource(ctx, { source, isLive: true }))) continue;
		await ctx.scheduler.runAfter(
			(opts.startDelayMs ?? 0) + scheduled * RUN_SPACING_MS,
			internal.mail.interpret.run.interpretMessage,
			{ source }
		);
		scheduled++;
	}
	if (scheduled > 0) await markBriefPending(ctx, ref);
	return scheduled;
}
