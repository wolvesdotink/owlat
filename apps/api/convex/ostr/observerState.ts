/**
 * The observer's publish-side storage seam: key observations (§7.5), the
 * cross-submission ledger (§9.1), and the accumulator snapshot (§7.4).
 *
 * Same rule as `store.ts` — V8 only, `ctx.db` only, no policy. The three
 * `@owlat/ostr-observer` stores this backs (`KeyObservationStore`, the
 * submission retry set, `TrafficAccumulator.serialize`/`restore`) are all
 * synchronous or pure in the package, so the Node action loads a working set
 * through these queries, runs the package against an in-memory adapter, and
 * writes the result back through these mutations. That read-modify-write is
 * safe because a single cron owns the whole window pass.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import {
	CURRENT_OSTR_ACCUMULATOR_STATE_VERSION,
	CURRENT_OSTR_ATTESTATION_BLOB_VERSION,
} from '../lib/constants';
import { OSTR_MAX_RETRY_SUBMISSIONS, OSTR_MAX_SUBMISSION_ATTEMPTS } from './config';

/** Ceiling on the key table one pass reads. A real instance sees far fewer
 *  distinct (domain, selector, key) triples than this in its lifetime. */
const MAX_KEY_OBSERVATIONS = 5000;

/** `KeyObservationRecord`, in the spelling the table holds. */
const keyObservationValidator = v.object({
	domain: v.string(),
	selector: v.string(),
	keyId: v.string(),
	publicKey: v.string(),
	firstSeen: v.string(),
	lastSeen: v.string(),
	isDnssecValidated: v.boolean(),
	lastEmittedWindowTo: v.optional(v.string()),
});

export interface StoredKeyObservation {
	domain: string;
	selector: string;
	keyId: string;
	publicKey: string;
	firstSeen: string;
	lastSeen: string;
	isDnssecValidated: boolean;
	lastEmittedWindowTo?: string;
}

/**
 * Every key this observer remembers.
 *
 * Loaded whole rather than looked up per sighting: the table holds one row per
 * (domain, selector, key) an instance has ever verified — a few hundred rows at
 * the top end — and the tracker's store interface is synchronous, so a working
 * set in memory is what it wants. `by_key` exists for the per-key read a future
 * challenge path will need.
 */
export const listKeyObservations = internalQuery({
	args: {},
	handler: async (ctx): Promise<StoredKeyObservation[]> => {
		const rows = await ctx.db.query('ostrKeyObservations').take(MAX_KEY_OBSERVATIONS);
		return rows.map((row) => ({
			domain: row.domain,
			selector: row.selector,
			keyId: row.keyId,
			publicKey: row.publicKey,
			firstSeen: row.firstSeen,
			lastSeen: row.lastSeen,
			isDnssecValidated: row.isDnssecValidated,
			lastEmittedWindowTo: row.lastEmittedWindowTo,
		}));
	},
});

/** Write back the records the tracker touched — upsert by (domain, selector,
 *  keyId), which is the identity the package compares on. */
export const putKeyObservations = internalMutation({
	args: { records: v.array(keyObservationValidator) },
	handler: async (ctx, args): Promise<void> => {
		const updatedAt = Date.now();
		for (const record of args.records) {
			const existing = await ctx.db
				.query('ostrKeyObservations')
				.withIndex('by_key', (q) =>
					q.eq('domain', record.domain).eq('selector', record.selector).eq('keyId', record.keyId)
				)
				.first();
			if (existing === null) await ctx.db.insert('ostrKeyObservations', { ...record, updatedAt });
			else await ctx.db.patch(existing._id, { ...record, updatedAt });
		}
	},
});

export interface PendingSubmission {
	id: Id<'ostrSubmissionLog'>;
	attestationJson: string;
	pendingLogUrls: string[];
	acceptedLogUrls: string[];
	attempts: number;
}

/**
 * Submissions no log has fully accepted yet, oldest first.
 *
 * The next window retries these BEFORE it builds anything new: a log that was
 * down for an hour should receive the backlog in the order it was produced, not
 * behind a fresh batch, because a log that timestamps on arrival would
 * otherwise sequence an older window after a newer one.
 */
export const listUnsettledSubmissions = internalQuery({
	args: {},
	handler: async (ctx): Promise<PendingSubmission[]> => {
		const rows = await ctx.db
			.query('ostrSubmissionLog')
			.withIndex('by_settled_and_created', (q) => q.eq('isSettled', false))
			.take(OSTR_MAX_RETRY_SUBMISSIONS);
		return rows.map((row) => ({
			id: row._id,
			attestationJson: row.attestationJson,
			pendingLogUrls: row.pendingLogUrls,
			acceptedLogUrls: row.acceptedLogUrls,
			attempts: row.attempts,
		}));
	},
});

const submissionOutcomeValidator = v.object({
	kind: v.string(),
	subject: v.string(),
	windowFrom: v.optional(v.string()),
	windowTo: v.optional(v.string()),
	attestationJson: v.string(),
	acceptedLogUrls: v.array(v.string()),
	pendingLogUrls: v.array(v.string()),
	lastError: v.optional(v.string()),
});

/**
 * Record what each freshly-signed attestation's submission achieved.
 *
 * A row is written for EVERY attestation, accepted or not. An observer that
 * only logged its failures could not answer "what did we publish, and where" —
 * and §9.1's redundancy claim is exactly that question. Fully-accepted rows are
 * settled on arrival and age out with the retention prune.
 */
export const recordSubmissions = internalMutation({
	args: { outcomes: v.array(submissionOutcomeValidator) },
	handler: async (ctx, args): Promise<void> => {
		const now = Date.now();
		for (const outcome of args.outcomes) {
			await ctx.db.insert('ostrSubmissionLog', {
				...outcome,
				attestationJsonVersion: CURRENT_OSTR_ATTESTATION_BLOB_VERSION,
				attempts: 1,
				isSettled: outcome.pendingLogUrls.length === 0,
				createdAt: now,
				updatedAt: now,
			});
		}
	},
});

/**
 * Fold a retry's result into an existing ledger row.
 *
 * Returns whether this attempt GAVE UP — `OSTR_MAX_SUBMISSION_ATTEMPTS` reached
 * with logs still owing an acceptance. An unsettled row is never pruned and only
 * the oldest are ever retried, so without a cap one permanently bad log URL
 * grows this table without limit while starving everything behind it. Giving up
 * settles the row (keeping `pendingLogUrls` and `lastError` as the record of
 * what never arrived) so retention can take it, and the caller surfaces it as an
 * operator-visible condition rather than a silent row.
 */
export const settleSubmission = internalMutation({
	args: {
		id: v.id('ostrSubmissionLog'),
		acceptedLogUrls: v.array(v.string()),
		pendingLogUrls: v.array(v.string()),
		lastError: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<boolean> => {
		const row = await ctx.db.get(args.id);
		if (row === null) return false;
		const attempts = row.attempts + 1;
		const isAbandoned = args.pendingLogUrls.length > 0 && attempts >= OSTR_MAX_SUBMISSION_ATTEMPTS;
		await ctx.db.patch(args.id, {
			acceptedLogUrls: args.acceptedLogUrls,
			pendingLogUrls: args.pendingLogUrls,
			lastError: args.lastError,
			attempts,
			isAbandoned: isAbandoned ? true : undefined,
			isSettled: args.pendingLogUrls.length === 0 || isAbandoned,
			updatedAt: Date.now(),
		});
		return isAbandoned;
	},
});

export interface ObserverRunState {
	accumulatorState: string | null;
	lastWindowTo: string | null;
	unpublishedFrom: string | null;
}

/** The singleton run state, or empty on the very first window. */
export const getRunState = internalQuery({
	args: {},
	handler: async (ctx): Promise<ObserverRunState> => {
		const row = await ctx.db.query('ostrObserverState').first();
		if (row === null) return { accumulatorState: null, lastWindowTo: null, unpublishedFrom: null };
		return {
			accumulatorState: row.accumulatorState,
			lastWindowTo: row.lastWindowTo ?? null,
			unpublishedFrom: row.unpublishedFrom ?? null,
		};
	},
});

/** Commit the accumulator snapshot and advance the window watermark. Written
 *  once, at the end of a pass, so a crash mid-pass replays the whole window
 *  rather than half-publishing it. `unpublishedFrom` unset clears the column:
 *  the traffic behind it has now been offered for publication. */
export const putRunState = internalMutation({
	args: {
		accumulatorState: v.string(),
		lastWindowTo: v.string(),
		unpublishedFrom: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<void> => {
		const row = await ctx.db.query('ostrObserverState').first();
		const patch = {
			accumulatorState: args.accumulatorState,
			accumulatorStateVersion: CURRENT_OSTR_ACCUMULATOR_STATE_VERSION,
			lastWindowTo: args.lastWindowTo,
			unpublishedFrom: args.unpublishedFrom,
			updatedAt: Date.now(),
		};
		if (row === null) await ctx.db.insert('ostrObserverState', patch);
		else await ctx.db.patch(row._id, patch);
	},
});
