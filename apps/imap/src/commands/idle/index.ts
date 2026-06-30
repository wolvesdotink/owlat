import { fn } from '../../convex.js';
import { logger } from '../../logger.js';
import type {
	CommandSession,
	ImapCommandModule,
	SelectedState,
} from '../types.js';
import { syncSession } from '../helpers/session.js';
import { requireAuth, requireSelect } from '../helpers/auth.js';
import { buildSeqMap, seqForUid } from '../helpers/seqMap.js';
import { formatFlags, type FetchEnvelope } from '../fetch/format.js';

interface PeekResult {
	readonly highestModseq: number;
	readonly uidNext: number;
	readonly totalCount: number;
	readonly unseenCount: number;
}

const POLL_INTERVAL_MS = 5_000;

/**
 * A single observed mailbox delta, as the unsolicited responses a server
 * must push to an IDLE-ing client (RFC 2177; RFC 3501 §7.4).
 *
 * Ordering matters and mirrors what real servers do: EXPUNGE first (in
 * DESCENDING sequence order so the client's local seq map stays valid as
 * it applies each one), then EXISTS for net new arrivals, then per-message
 * FETCH for flag changes. The `exists`/`uidNext` fields carry the new
 * folder counters the IDLE module patches onto its tracked SelectedState.
 */
export interface IdleDelta {
	/** `* n EXPUNGE` sequence numbers, already in descending order. */
	readonly expunged: readonly number[];
	/** New `* n EXISTS` total, or undefined when no new message arrived. */
	readonly exists?: number;
	/** New uidNext, threaded onto SelectedState alongside `exists`. */
	readonly uidNext?: number;
	/** Per-message `* n FETCH (UID … FLAGS (…))` lines for flag changes. */
	readonly fetches: readonly string[];
}

/**
 * Diff a folder's prior IDLE snapshot against a fresh peek + the rows that
 * changed since the last poll, producing the unsolicited responses to push.
 *
 * Pure so it can be unit-tested without timers or a live Convex client.
 *
 *   - **Expunges**: UIDs present last poll but absent now. Their sequence
 *     numbers are resolved against the *prior* UID list (the client still
 *     holds that view) and emitted DESCENDING so each `* n EXPUNGE` keeps
 *     the remaining seq numbers valid (RFC 3501 §7.4.1).
 *   - **Exists**: reported as `* n EXISTS` (the new total) whenever a new
 *     UID arrived since the prior view — even if the net count stayed flat
 *     or dropped because the same coalesced window also expunged messages.
 *     A pure decrease (no arrival) is conveyed solely via EXPUNGE, never a
 *     (wrong) lower EXISTS.
 *   - **Fetches**: rows whose modseq advanced past `lastModseq` and that
 *     still exist after expunges, addressed by their *current* sequence
 *     number — newly-appended rows are skipped here because EXISTS already
 *     announced them.
 */
export function diffIdle(args: {
	readonly prevUids: readonly number[];
	readonly nextUids: readonly number[];
	readonly prevTotal: number;
	readonly nextTotal: number;
	readonly nextUidNext: number;
	readonly lastModseq: number;
	readonly changedRows: readonly FetchEnvelope[];
}): IdleDelta {
	const prevMap = buildSeqMap(args.prevUids);
	const nextMap = buildSeqMap(args.nextUids);
	const nextUidSet = new Set(args.nextUids);
	const prevUidSet = new Set(args.prevUids);

	const expunged = args.prevUids
		.filter((uid) => !nextUidSet.has(uid))
		.map((uid) => seqForUid(prevMap, uid) ?? 0)
		.filter((seq) => seq > 0)
		.sort((a, b) => b - a);

	// Announce EXISTS whenever *arrivals* occurred, not merely when the count
	// grew. The 5s poll coalesces every concurrent op, so a window that both
	// appends and expunges can net to an unchanged or even lower count while
	// still containing a new message (e.g. 3→2: UIDs 2,3 expunged, UID 4
	// appended). Detect arrivals from the UID set diff — UIDs present now but
	// not in the prior view — so a mixed window still emits the EXISTS RFC 3501
	// §7.4.1 requires for any new arrival, instead of silently hiding it behind
	// the EXPUNGEs until the next count change.
	const hasArrivals = args.nextUids.some((uid) => !prevUidSet.has(uid));
	const exists = hasArrivals ? args.nextTotal : undefined;

	const fetches: string[] = [];
	for (const row of args.changedRows) {
		// Only push FLAGS for rows the client already knew about: a brand-new
		// UID is an arrival, announced by EXISTS, not a flag change.
		if (!nextUidSet.has(row.uid)) continue;
		if (!prevUidSet.has(row.uid)) continue;
		const seq = seqForUid(nextMap, row.uid);
		if (seq === undefined) continue;
		fetches.push(
			`* ${seq} FETCH (UID ${row.uid} MODSEQ (${row.modseq}) FLAGS (${formatFlags(row)}))`,
		);
	}

	return {
		expunged,
		...(exists !== undefined ? { exists, uidNext: args.nextUidNext } : {}),
		fetches,
	};
}

/**
 * IDLE (RFC 2177) — long-running. Owns its poll loop and the
 * server-side idle-timeout timer. Resolves the session's `completion`
 * via one of three paths:
 *
 *   1. Client sends bare `DONE` → onClientLine consumes it
 *   2. The configured idle timeout fires → emit `* OK [TIMEOUT]` + OK
 *   3. Socket closes (cancel) → tear down timers, resolve with the
 *      currently-tracked state so the pump's `.then` continuation
 *      releases its session reference
 *
 * During IDLE the poll loop diffs the folder against its last snapshot and
 * pushes unsolicited EXPUNGE / EXISTS / FETCH responses (RFC 3501 §7.4) so
 * other clients' deletes, arrivals, and flag changes are seen live, then
 * patches the locally-tracked SelectedState so the pump applies the fresh
 * counters when the session resolves.
 */
export const idleModule: ImapCommandModule<void> = {
	verbs: ['IDLE'],
	capabilities: ['IDLE'],
	parseArgs: () => ({ ok: true, args: undefined }),
	start({ deps, state, tag, send }) {
		const fail = requireAuth(state, tag) ?? requireSelect(state, tag);
		if (fail) {
			send(fail);
			return syncSession();
		}

		let currentSelected: SelectedState = state.selected!;
		let resolved = false;
		let resolveCompletion!: () => void;
		const completion = new Promise<void>((r) => {
			resolveCompletion = r;
		});

		const finalize = (lines: readonly string[]): void => {
			if (resolved) return;
			resolved = true;
			clearInterval(pollTimer);
			clearTimeout(idleTimer);
			deps.commit({ ...state, selected: currentSelected });
			for (const l of lines) send(l);
			resolveCompletion();
		};

		send('+ idling');

		let lastModseq = currentSelected.highestModseq;
		let lastTotal = currentSelected.totalCount;
		// The set of UIDs the client currently believes it holds — the source of
		// truth for resolving expunged-message sequence numbers against the view
		// the client still has. The SELECT state carries counts, not the UID
		// list, so we snapshot it once at IDLE entry (this reflects the client's
		// view because it has just SELECTed) and keep it in lock-step with what
		// we have already announced thereafter, so every diff is exact.
		let lastUids: number[] | null = null;
		const seedUids = (async () => {
			try {
				lastUids = (await deps.convex.query(fn.listFolderUids as never, {
					folderId: currentSelected.folderId,
				} as never)) as number[];
			} catch (err) {
				logger.warn({ err }, 'IDLE seed UID list failed');
			}
		})();

		const pollTimer = setInterval(async () => {
			try {
				await seedUids;
				const peek = (await deps.convex.query(fn.peekFolderModseq as never, {
					folderId: currentSelected.folderId,
				} as never)) as PeekResult | null;
				if (!peek) return;
				// Nothing observable changed → cheap path, no UID list fetch.
				if (peek.totalCount === lastTotal && peek.highestModseq === lastModseq) {
					return;
				}

				const nextUids = (await deps.convex.query(fn.listFolderUids as never, {
					folderId: currentSelected.folderId,
				} as never)) as number[];
				// Rows whose flags (or any field) changed since the last announced
				// modseq. One range query over the whole folder; the convex side
				// filters to modseq > lastModseq.
				const changedRows =
					peek.highestModseq !== lastModseq
						? ((await deps.convex.query(fn.fetchEnvelopes as never, {
								folderId: currentSelected.folderId,
								uidLow: 1,
								uidHigh: Math.max(peek.uidNext - 1, 1),
								modseqSince: lastModseq,
							} as never)) as FetchEnvelope[])
						: [];

				const prevUids = lastUids ?? nextUids;
				const delta = diffIdle({
					prevUids,
					nextUids,
					prevTotal: lastTotal,
					nextTotal: peek.totalCount,
					nextUidNext: peek.uidNext,
					lastModseq,
					changedRows,
				});

				for (const seq of delta.expunged) send(`* ${seq} EXPUNGE`);
				if (delta.exists !== undefined) send(`* ${delta.exists} EXISTS`);
				for (const line of delta.fetches) send(line);

				currentSelected = {
					...currentSelected,
					totalCount: peek.totalCount,
					uidNext: peek.uidNext,
					highestModseq: peek.highestModseq,
				};
				lastTotal = peek.totalCount;
				lastModseq = peek.highestModseq;
				lastUids = nextUids;
			} catch (err) {
				logger.warn({ err }, 'IDLE poll failed');
			}
		}, POLL_INTERVAL_MS);

		const idleTimer = setTimeout(() => {
			finalize([
				'* OK [TIMEOUT] IDLE timeout — re-issue IDLE',
				`${tag} OK IDLE terminated by server`,
			]);
		}, deps.config.idleTimeoutMs);

		const session: CommandSession = {
			completion,
			onClientLine(line) {
				if (line.trim().toUpperCase() === 'DONE') {
					finalize([`${tag} OK IDLE terminated`]);
					return 'absorbed';
				}
				return 'pass';
			},
			cancel() {
				if (resolved) return;
				clearInterval(pollTimer);
				clearTimeout(idleTimer);
				resolved = true;
				deps.commit({ ...state, selected: currentSelected });
				resolveCompletion();
			},
		};
		return session;
	},
};
