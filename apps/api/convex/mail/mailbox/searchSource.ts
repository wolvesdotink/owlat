/**
 * Which index range a text-free search walks, and the cursor that remembers it.
 *
 * A text-free clause is verified row by row in JS (`matchesClause`), so any
 * index range that holds every matching row in arrival order gives the same
 * result. The narrowest one the clause allows is read: the folder's arrival
 * range for a resolved positive `in:`, bounded by `after:`/`before:`, else the
 * mailbox's arrival range under the same bounds. A disjunction walks the whole
 * mailbox, because its sides share no folder or date bound.
 *
 * A native Convex cursor is a position in ONE query; replayed against another
 * range it skips or repeats rows. So the single-mailbox cursor names its
 * source: an untagged cursor is the unbounded mailbox walk (what every cursor
 * was before sources were narrowed, and still the common case), a tagged one
 * carries the folder and bounds it was minted on. The fan-out keyset carries
 * the folder per mailbox position instead (`searchCursor.ts`).
 */

import type { Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import type { ResolvedNames, SearchClause } from './searchClause';

/** The index range a text-free scan reads. Every bound is exclusive. */
export interface ScanSource {
	/** The folder's arrival index; absent = the mailbox's arrival index. */
	folderId?: Id<'mailFolders'>;
	afterMs?: number;
	beforeMs?: number;
}

/**
 * The narrowest source for the live (non-dead) clauses. A live clause's
 * positive `in:` always resolved to a folder, otherwise it would be dead.
 */
export function scanSourceFor(live: readonly SearchClause[], names: ResolvedNames): ScanSource {
	if (live.length !== 1) return {};
	const clause = live[0]!;
	const folderId = clause.folderRole ? names.folderByRole.get(clause.folderRole) : undefined;
	return {
		...(folderId ? { folderId } : {}),
		...(clause.afterMs !== undefined ? { afterMs: clause.afterMs } : {}),
		...(clause.beforeMs !== undefined ? { beforeMs: clause.beforeMs } : {}),
	};
}

export function isSameSource(left: ScanSource, right: ScanSource): boolean {
	return (
		left.folderId === right.folderId &&
		left.afterMs === right.afterMs &&
		left.beforeMs === right.beforeMs
	);
}

function isMailboxWide(source: ScanSource): boolean {
	return isSameSource(source, {});
}

/** The same date bounds over the mailbox's arrival index. */
export function mailboxWide(source: ScanSource): ScanSource {
	return {
		...(source.afterMs !== undefined ? { afterMs: source.afterMs } : {}),
		...(source.beforeMs !== undefined ? { beforeMs: source.beforeMs } : {}),
	};
}

/**
 * Prefix of a source-tagged cursor. A colon never occurs in a native Convex
 * cursor, so an untagged cursor cannot be mistaken for a tagged one.
 */
const SOURCE_CURSOR_TAG = 'src1:';

/** The continuation cursor for `native`, minted on `source`. */
export function encodeSourceCursor(source: ScanSource, native: string): string {
	if (isMailboxWide(source)) return native;
	return (
		SOURCE_CURSOR_TAG +
		JSON.stringify({ f: source.folderId, a: source.afterMs, b: source.beforeMs, c: native })
	);
}

/**
 * The source a cursor was minted on and its native position, or `null` for a
 * tagged cursor that does not decode.
 */
export function decodeSourceCursor(raw: string): { source: ScanSource; native: string } | null {
	if (!raw.startsWith(SOURCE_CURSOR_TAG)) return { source: {}, native: raw };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(SOURCE_CURSOR_TAG.length));
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const { f, a, b, c } = parsed as Record<string, unknown>;
	if (typeof c !== 'string') return null;
	if (f !== undefined && typeof f !== 'string') return null;
	if (a !== undefined && typeof a !== 'number') return null;
	if (b !== undefined && typeof b !== 'number') return null;
	return {
		source: {
			...(f !== undefined ? { folderId: f as Id<'mailFolders'> } : {}),
			...(a !== undefined ? { afterMs: a } : {}),
			...(b !== undefined ? { beforeMs: b } : {}),
		},
		native: c,
	};
}

/**
 * The source a resumed walk reads, or `null` when the cursor belongs to a
 * source this request must not continue.
 *
 * A mailbox-wide cursor resumes as minted: it reads only the mailbox the
 * caller was already authorized for, and the JS filter decides what matches.
 * A folder cursor resumes only when the request resolves the same folder; any
 * other folder id came from a recreated folder or a forged cursor and could
 * belong to another mailbox.
 */
export function resumableSource(minted: ScanSource, derived: ScanSource): ScanSource | null {
	if (minted.folderId === undefined) return minted;
	return isSameSource(minted, derived) ? minted : null;
}

/** `receivedAt <= at`: where a fan-out keyset resumes. */
export interface ResumeBound {
	at: number;
}

/**
 * The source's rows newest first, from `resume` (inclusive) or the source's
 * upper bound, down to its lower bound. `null` when the bounds leave nothing
 * to read.
 */
export function arrivalScan(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>,
	source: ScanSource,
	resume?: ResumeBound
) {
	const lower = source.afterMs;
	const upper =
		resume !== undefined && (source.beforeMs === undefined || resume.at < source.beforeMs)
			? { value: resume.at, isInclusive: true }
			: source.beforeMs !== undefined
				? { value: source.beforeMs, isInclusive: false }
				: undefined;
	if (lower !== undefined && upper !== undefined && upper.value <= lower) return null;

	const messages = ctx.db.query('mailMessages');
	const folderId = source.folderId;
	const query = folderId
		? messages.withIndex('by_folder_and_received', (q) => {
				const eq = q.eq('folderId', folderId);
				const low = lower === undefined ? eq : eq.gt('receivedAt', lower);
				if (!upper) return low;
				return upper.isInclusive
					? low.lte('receivedAt', upper.value)
					: low.lt('receivedAt', upper.value);
			})
		: messages.withIndex('by_mailbox_and_received', (q) => {
				const eq = q.eq('mailboxId', mailboxId);
				const low = lower === undefined ? eq : eq.gt('receivedAt', lower);
				if (!upper) return low;
				return upper.isInclusive
					? low.lte('receivedAt', upper.value)
					: low.lt('receivedAt', upper.value);
			});
	return query.order('desc');
}
