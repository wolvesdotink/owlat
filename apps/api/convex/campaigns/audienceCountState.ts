/**
 * Audience count state (helper) — what identifies an audience DEFINITION for
 * the resumable exact count (#916), and how the subscribed wizard readout finds
 * the count job for the definition it is showing.
 *
 * Kept apart from `audienceCountJob.ts` so the public `countRecipients` query
 * (`audienceResolution.ts`) can read job state without importing the job
 * module, which itself imports the page resolver: the dependency runs
 * `audienceCountJob.ts` → `audienceResolution.ts` → this module.
 */

import type { QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import type { StoredAudience } from './audience';

/** A complete count is served as exact; past this age the wizard asks for a recount. */
export const AUDIENCE_COUNT_MAX_AGE_MS = 15 * 60_000;

/**
 * A `counting` row that has not advanced for this long is treated as stalled
 * (a step threw before rescheduling itself); a new request restarts it. Steps
 * are scheduled back to back, so a healthy row advances every few seconds.
 */
export const AUDIENCE_COUNT_STALL_MS = 2 * 60_000;

/** One audience definition: its key and the snapshot every step resolves. */
export interface AudienceCountTarget {
	key: string;
	/** The topic or segment id. */
	ref: string;
	/** The audience with the segment filters frozen in. */
	audience: StoredAudience;
}

/** JSON with object keys sorted, so equal definitions always serialize equally. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/** 64-bit FNV-1a as two independently seeded 32-bit lanes, hex. */
function definitionHash(text: string): string {
	let a = 0x811c9dc5;
	let b = 0xcbf29ce4;
	for (let i = 0; i < text.length; i += 1) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193);
		b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
	}
	return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Derive the definition an audience currently resolves to. `null` when there
 * is nothing to count (a segment that no longer exists).
 *
 * The key covers what decides membership and the eligibility rules applied to
 * it: a topic and its `requireDoubleOptIn` flag; a segment and the filters it
 * resolves (the send-time snapshot when the audience carries one, else the live
 * Segment's). Contact rows and the blocklist are not in the key; they are
 * covered by the freshness window instead (see the `audienceCountJobs` table).
 */
export async function audienceCountTarget(
	ctx: QueryCtx,
	audience: StoredAudience
): Promise<AudienceCountTarget | null> {
	if (audience.kind === 'topic') {
		const topic = await ctx.db.get(audience.topicId);
		const doi = topic?.requireDoubleOptIn === true ? 1 : 0;
		return {
			key: `topic:${audience.topicId}:doi=${doi}`,
			ref: audience.topicId,
			audience: { kind: 'topic', topicId: audience.topicId },
		};
	}
	let filters = audience.frozenFilters;
	if (!filters) {
		const segment = await ctx.db.get(audience.segmentId);
		if (!segment) return null;
		filters = segment.filters;
	}
	return {
		key: `segment:${audience.segmentId}:${definitionHash(canonicalJson(filters))}`,
		ref: audience.segmentId,
		audience: { kind: 'segment', segmentId: audience.segmentId, frozenFilters: filters },
	};
}

/** Does the job row count exactly this definition (key AND snapshot)? */
export function jobCountsTarget(
	job: Pick<Doc<'audienceCountJobs'>, 'audienceKey' | 'resolvedAudience'>,
	target: AudienceCountTarget
): boolean {
	return (
		job.audienceKey === target.key &&
		canonicalJson(job.resolvedAudience) === canonicalJson(target.audience)
	);
}

/** The job row for this definition, if any. One indexed read. */
export async function findAudienceCountJob(
	ctx: QueryCtx,
	target: AudienceCountTarget
): Promise<Doc<'audienceCountJobs'> | null> {
	const job = await ctx.db
		.query('audienceCountJobs')
		.withIndex('by_audience_key', (q) => q.eq('audienceKey', target.key))
		.first();
	return job !== null && jobCountsTarget(job, target) ? job : null;
}

/**
 * Where the exact count for the readout stands. Returned beside the numbers by
 * `countRecipients` so the wizard can say which kind of number it shows.
 *
 *  - `not_needed`  — the inline page reached the end: the numbers are exact
 *                    and live (they rerun with the data).
 *  - `unavailable` — the inline page stopped short and no count job holds this
 *                    definition; the numbers are a lower bound and the client
 *                    may request a job.
 *  - `counting`    — a job is running; the numbers are its running totals (a
 *                    lower bound).
 *  - `complete`    — a job finished; the numbers are its exact result as of
 *                    `countedAt` (see the freshness contract). `recounting`
 *                    marks a newer count running behind it; the numbers stay
 *                    the previous result until that one completes.
 *
 * `retryAfter` is when a request would do something again: a stalled job
 * restarts, a complete one recounts. Requesting earlier is a no-op.
 */
export type AudienceCountBackground =
	| { status: 'not_needed' }
	| { status: 'unavailable' }
	| { status: 'counting'; startedAt: number; retryAfter: number }
	| { status: 'complete'; countedAt: number; retryAfter: number; recounting?: true };

/** Is this row still worth serving and not worth restarting at `now`? */
export function isAudienceCountJobCurrent(job: Doc<'audienceCountJobs'>, now: number): boolean {
	if (job.status === 'counting') return now - job.updatedAt < AUDIENCE_COUNT_STALL_MS;
	if (job.status === 'complete') {
		return now - (job.completedAt ?? job.updatedAt) < AUDIENCE_COUNT_MAX_AGE_MS;
	}
	return false;
}
