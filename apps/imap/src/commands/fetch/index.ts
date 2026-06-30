import type { ConvexClient } from '../../convex.js';
import { fn } from '../../convex.js';
import { logger } from '../../logger.js';
import { parseList } from '../../parser.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { requireAuth, requireSelect } from '../helpers/auth.js';
import { buildSeqMap, resolveSet } from '../helpers/seqMap.js';
import {
	type FetchEnvelope,
	formatEnvelope,
	formatFlags,
	formatInternalDate,
} from './format.js';
import {
	type BodySectionRequest,
	formatBodySection,
	parseBodySectionItem,
} from './bodySection.js';

export interface FetchArgs {
	readonly set: string;
	readonly itemsToken: string;
	readonly byUid: boolean;
}

interface StoreFlagsResult {
	readonly updated: ReadonlyArray<{ uid: number; modseq: number; flags: string[] }>;
	readonly unchanged: ReadonlyArray<{ uid: number }>;
}

/**
 * FETCH and UID FETCH share this module. The UID dispatcher constructs
 * args with `byUid: true`; direct FETCH defaults to false.
 *
 * The message set is resolved against a freshly-built sequence ↔ UID map
 * (the folder's UIDs ascending; position i is sequence number i+1, RFC
 * 3501 §2.3.1). A non-UID set holds *sequence numbers* (positions), a UID
 * set holds UIDs; either way each matched row carries its true sequence
 * number in the `* {seq} FETCH` reply — never a fabricated 1..N counter.
 *
 * Body retrieval (RFC 3501 §6.4.5) supports the whole message, the
 * HEADER / TEXT sections, single-part bodies, the RFC822* aliases, and
 * partial `<offset.length>` slices. A non-`.PEEK` body retrieval on a
 * read-write mailbox sets \Seen as a side effect (§7.4.2) and the FETCH
 * response carries the resulting FLAGS.
 */
export const fetchModule: ImapCommandModule<FetchArgs> = {
	verbs: ['FETCH'],
	parseArgs(rawArgs) {
		const [set, itemsToken] = rawArgs;
		if (!set || !itemsToken) {
			return { ok: false, error: 'FETCH requires <set> (items)' };
		}
		return { ok: true, args: { set, itemsToken, byUid: false } };
	},
	start({ deps, state, args, tag, send }) {
		const fail = requireAuth(state, tag) ?? requireSelect(state, tag);
		if (fail) {
			send(fail);
			return syncSession();
		}

		const rawItems = parseList(args.itemsToken).map((s) => s.toUpperCase());
		const items = new Set(rawItems);
		// Body sections in request order; non-body items handled via the set.
		const bodyRequests: BodySectionRequest[] = [];
		for (const item of rawItems) {
			const req = parseBodySectionItem(item);
			if (req) bodyRequests.push(req);
		}
		const needsRaw = bodyRequests.length > 0;
		// A non-PEEK body retrieval implicitly sets \Seen on a read-write
		// mailbox (§7.4.2). EXAMINE / read-only selects never mutate flags.
		const setsSeen =
			!state.selected!.readOnly && bodyRequests.some((b) => !b.peek);

		const label = args.byUid ? 'UID FETCH' : 'FETCH';

		return asyncSession(async () => {
			try {
				// Build the sequence ↔ UID map for the SELECTed folder, then
				// resolve the set against it. A non-UID set holds positions; a
				// UID set holds UIDs. Either way `resolved` is ordered by true
				// sequence number and carries the UID to fetch.
				const folderUids = (await deps.convex.query(
					fn.listFolderUids as never,
					{ folderId: state.selected!.folderId } as never,
				)) as number[];
				const seqMap = buildSeqMap(folderUids);
				const resolved = resolveSet(seqMap, args.set, args.byUid);

				if (resolved.length === 0) {
					send(`${tag} OK ${label} completed`);
					return;
				}

				// One envelope query over the min..max UID span; index the rows
				// by UID so each resolved {uid, seq} can be emitted in true
				// sequence order even across gaps.
				const uids = resolved.map((r) => r.uid);
				const slice = (await deps.convex.query(fn.fetchEnvelopes as never, {
					folderId: state.selected!.folderId,
					uidLow: Math.min(...uids),
					uidHigh: Math.max(...uids),
				} as never)) as FetchEnvelope[];
				const byUidMap = new Map<number, FetchEnvelope>();
				for (const m of slice) byUidMap.set(m.uid, m);

				for (const { uid, seq } of resolved) {
					const m = byUidMap.get(uid);
					if (!m) continue;
					const fields: string[] = [];

					// Implicit \Seen must be applied before the FLAGS field is
					// emitted so the response reflects the new flag set.
					let seenFlags: string | undefined;
					if (setsSeen && !m.flagSeen) {
						seenFlags = await markSeen(deps.convex, m._id);
					}

					if (args.byUid || items.has('UID')) fields.push(`UID ${m.uid}`);
					if (items.has('FLAGS') || setsSeen) {
						fields.push(`FLAGS (${seenFlags ?? formatFlagsWithSeen(m, setsSeen)})`);
					}
					if (items.has('INTERNALDATE')) {
						fields.push(`INTERNALDATE "${formatInternalDate(m.internalDate)}"`);
					}
					if (items.has('RFC822.SIZE')) fields.push(`RFC822.SIZE ${m.rawSize}`);
					if (items.has('ENVELOPE')) fields.push(`ENVELOPE ${formatEnvelope(m)}`);
					if (items.has('MODSEQ')) fields.push(`MODSEQ (${m.modseq})`);

					if (needsRaw) {
						const raw = await fetchRawBody(deps.convex, m._id);
						if (raw != null) {
							for (const req of bodyRequests) {
								fields.push(formatBodySection(req, raw));
							}
						}
					}

					send(`* ${seq} FETCH (${fields.join(' ')})`);
				}

				send(`${tag} OK ${label} completed`);
			} catch (err) {
				logger.error({ err }, 'FETCH failed');
				send(`${tag} BAD ${label} failed`);
			}
		});
	},
};

/**
 * Render the message's flags as they will be after an implicit \Seen.
 * Used only when \Seen was already set on the row (so markSeen was
 * skipped) but the response must still carry FLAGS.
 */
function formatFlagsWithSeen(m: FetchEnvelope, setsSeen: boolean): string {
	const base = formatFlags(m);
	if (!setsSeen || m.flagSeen) return base;
	return base.length > 0 ? `\\Seen ${base}` : '\\Seen';
}

/**
 * Add \Seen to a message via the shared storeFlags mutation and return
 * the formatted flag string from the mutation result. Returns undefined
 * if the mutation reports no update (e.g. the row vanished) so the caller
 * falls back to the envelope's own flags.
 */
async function markSeen(
	convex: ConvexClient,
	messageId: string,
): Promise<string | undefined> {
	const result = (await convex.mutation(fn.storeFlags as never, {
		messageIds: [messageId],
		flags: ['\\Seen'],
		mode: 'add',
	} as never)) as StoreFlagsResult;
	const row = result.updated[0];
	return row ? row.flags.join(' ') : undefined;
}

/**
 * Pull a message's raw bytes out of Convex storage. Returns null on any
 * failure so FETCH can drop the body fields gracefully without aborting
 * the whole multi-row response.
 */
async function fetchRawBody(
	convex: ConvexClient,
	messageId: string,
): Promise<string | null> {
	try {
		const meta = (await convex.query(fn.fetchRawStorageId as never, {
			messageId,
		} as never)) as { storageId: string; rawSize: number } | null;
		if (!meta) return null;
		const url = (await convex
			.query(fn.getRawStorageUrl as never, {
				storageId: meta.storageId,
			} as never)
			.catch(() => null)) as string | null;
		if (!url) return null;
		const res = await fetch(url);
		if (!res.ok) return null;
		return await res.text();
	} catch (err) {
		logger.warn({ err, messageId }, 'fetchRawBody failed');
		return null;
	}
}
