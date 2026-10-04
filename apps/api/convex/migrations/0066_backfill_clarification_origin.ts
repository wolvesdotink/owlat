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
 * ({@link legacyAttributionOrigin}, which reads the domain the way the web's
 * old fallback did), and loses the sentence. A question that already has
 * `origin` keeps it and only loses the sentence.
 *
 * REQUIRED BEFORE 0.6.11. Introduced in 0.6.10 as a stepping stone; 0.6.11
 * (#1224) removed `attribution` from the schema, so its deploy is rejected
 * while any stored question still has the field. Run it on 0.6.10, then once
 * more with `'{"restart":true}'` after every action started before the 0.6.10
 * deploy has finished (one of those can store a question with `attribution`
 * behind the cursor), and update only once that pass has completed.
 *
 * On a deployment that runs the schema without `attribution`, no stored
 * question can carry it, so a run there scans and changes nothing. The module
 * stays so its ledger row and path stay valid (a page chain a 0.6.10 run queued
 * still finds its function after the update), and it keeps its own parser
 * because nothing else reads the sentence any more.
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
import type { ClarificationOrigin } from '../inbox/clarificationSlots';
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

/**
 * A stored question's provenance as this walk reads it. `attribution` is no
 * longer in the schema's question type; a row stored before 0.6.10 carried it.
 */
interface LegacyProvenance {
	attribution?: string | undefined;
	origin?: ClarificationOrigin | undefined;
}

/**
 * The `origin` a legacy `attribution` sentence implies. Reads the domain the
 * way the web's fallback (`attributionDomain`, removed in 0.6.11) did, so a
 * converted question shows the same trust line: a sentence naming a domain
 * gives `{ kind: 'email', senderDomain }`, one naming none gives
 * `{ kind: 'email' }`, and an absent or empty sentence gives no origin (the web
 * showed no line for it either).
 */
export function legacyAttributionOrigin(
	attribution: string | undefined
): ClarificationOrigin | undefined {
	if (!attribution) return undefined;
	const domain = attribution.match(/\ban email from (\S+)/i)?.[1]?.replace(/[.,;:]+$/, '');
	return domain ? { kind: 'email', senderDomain: domain } : { kind: 'email' };
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
