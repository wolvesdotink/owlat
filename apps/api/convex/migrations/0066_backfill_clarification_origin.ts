/**
 * Convert legacy clarification provenance to `origin` (migration 0066).
 *
 *   npx convex run migrations/0066_backfill_clarification_origin:run
 *
 * Clarification questions used to store their provenance as one English
 * sentence (`attribution`: "Generated from an email from acme.com — Owlat will
 * never ask for your password."). Since #1177 every question also carries the
 * structured `origin` the web words in the reader's language, and since #1186
 * nothing writes `attribution` any more. This walk converts what is left: each
 * question that still has `attribution` gets the `origin` its sentence implies
 * (inbox/clarificationSlots.ts legacyAttributionOrigin, which reads the domain
 * the way the web's fallback does), and loses the sentence. A question that
 * already has `origin` keeps it and only loses the sentence.
 *
 * Optional for the release that ships it: until it has run, the web reads the
 * domain out of the sentence, so the trust line looks the same either way. It
 * is the stepping stone for the contract step that drops `attribution` from
 * the schema and the web fallback: that step needs every row converted.
 *
 * TWO PASSES, one ledger row:
 *   1. `threads`: `mailThreads.needsReply.clarification.questions` (the Reply
 *      Queue). These never age out: an answered clarification stays on the
 *      thread for as long as the thread is flagged.
 *   2. `sessions`: `answerAskSessions.questions` (Answer mode).
 *
 * DURABLE AND RESUMABLE: progress and completion live in the migration ledger
 * (`migrationRuns` row `0066_backfill_clarification_origin`,
 * lib/migrationLedger.ts); the cursor carries its pass as a prefix. Running
 * `run` again on an unfinished pass resumes it; on a finished one it does
 * nothing (`'{"restart":true}'` starts over). Pages are idempotent: a
 * converted question has no `attribution` left to convert.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import { logInfo } from '../lib/runtimeLog';
import { legacyAttributionOrigin, type ClarificationOrigin } from '../inbox/clarificationSlots';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
} from '../lib/migrationLedger';

export const MIGRATION = '0066_backfill_clarification_origin';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.10';

/** Threads per page; most carry no clarification and are only read. */
const THREAD_PAGE_SIZE = 100;
/** Sessions per page; each holds the drafter's context (thread text). */
const SESSION_PAGE_SIZE = 25;

type Pass = 'threads' | 'sessions';

/** The ledger cursor: `<pass>:<convex cursor>`, an empty cursor for a pass's first page. */
export function encodeCursor(pass: Pass, cursor: string | null): string {
	return `${pass}:${cursor ?? ''}`;
}

export function decodeCursor(stored: string | null | undefined): {
	pass: Pass;
	cursor: string | null;
} {
	if (!stored) return { pass: 'threads', cursor: null };
	const split = stored.indexOf(':');
	const pass = stored.slice(0, split) === 'sessions' ? 'sessions' : 'threads';
	const cursor = split === -1 ? null : stored.slice(split + 1);
	return { pass, cursor: cursor || null };
}

interface LegacyProvenance {
	attribution?: string | undefined;
	origin?: ClarificationOrigin | undefined;
}

/**
 * The questions with every legacy `attribution` converted to `origin`, or null
 * when none of them carries one (nothing to write).
 */
export function convertQuestions<Q extends LegacyProvenance>(questions: Q[]): Q[] | null {
	if (!questions.some((q) => q.attribution !== undefined)) return null;
	return questions.map((question) => {
		if (question.attribution === undefined) return question;
		const { attribution, ...rest } = question;
		const origin = question.origin ?? legacyAttributionOrigin(attribution);
		return (origin ? { ...rest, origin } : rest) as Q;
	});
}

async function threadsPage(ctx: MutationCtx, cursor: string | null) {
	const { page, continueCursor, isDone } = await ctx.db
		.query('mailThreads')
		.paginate({ numItems: THREAD_PAGE_SIZE, cursor });
	let changed = 0;
	for (const thread of page) {
		const clarification = thread.needsReply?.clarification;
		if (!thread.needsReply || !clarification) continue;
		const questions = convertQuestions(clarification.questions);
		if (!questions) continue;
		// A data conversion, not an edit: `updatedAt` stays as it was.
		await ctx.db.patch(thread._id, {
			needsReply: { ...thread.needsReply, clarification: { ...clarification, questions } },
		});
		changed++;
	}
	return { continueCursor, isDone, scanned: page.length, changed };
}

async function sessionsPage(ctx: MutationCtx, cursor: string | null) {
	const { page, continueCursor, isDone } = await ctx.db
		.query('answerAskSessions')
		.paginate({ numItems: SESSION_PAGE_SIZE, cursor });
	let changed = 0;
	for (const session of page) {
		const questions = convertQuestions(session.questions);
		if (!questions) continue;
		await ctx.db.patch(session._id, { questions });
		changed++;
	}
	return { continueCursor, isDone, scanned: page.length, changed };
}

/** Run one page of the current pass and schedule the next one of the same run. */
export const processPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
	handler: async (ctx, args): Promise<{ isDone: boolean; isSuperseded?: boolean }> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0066_backfill_clarification_origin.superseded', {
				generation: args.generation,
			});
			return { isDone: false, isSuperseded: true };
		}
		const { pass, cursor } = decodeCursor(args.cursor);
		const result =
			pass === 'threads' ? await threadsPage(ctx, cursor) : await sessionsPage(ctx, cursor);
		const next =
			pass === 'threads' && result.isDone
				? encodeCursor('sessions', null)
				: encodeCursor(pass, result.continueCursor);
		const isDone = pass === 'sessions' && result.isDone;
		await recordMigrationPage(ctx, run, {
			cursor: next,
			isDone,
			scanned: result.scanned,
			changed: result.changed,
		});
		logInfo('migration.0066_backfill_clarification_origin.page', {
			pass,
			scanned: result.scanned,
			changed: result.changed,
			isDone,
			generation: run.generation,
		});
		if (!isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations['0066_backfill_clarification_origin'].processPage,
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
			internal.migrations['0066_backfill_clarification_origin'].processPage,
			{ cursor: begun.cursor ?? null, generation: begun.generation }
		);
		logInfo('migration.0066_backfill_clarification_origin.started', {
			cursor: begun.cursor ?? null,
			generation: begun.generation,
		});
		return { started: true, generation: begun.generation };
	},
});
