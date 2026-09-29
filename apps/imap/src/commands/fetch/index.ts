import { logger } from '../../logger.js';
import { parseList } from '../../parser.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession } from '../helpers/session.js';
import { resolveSelectedSet } from '../helpers/seqMap.js';
import { loadEnvelopes } from '../helpers/folderPaging.js';
import { type FetchEnvelope, formatEnvelope, formatFlags, formatInternalDate } from './format.js';
import { type BodySectionRequest, formatBodySection, parseBodySectionItem } from './bodySection.js';
import { serverFailure } from '../helpers/replies.js';
import {
	downloadRaw,
	forEachOrdered,
	markSeenBatch,
	mintRawUrls,
	RAW_DOWNLOAD_CONCURRENCY,
	RAW_URL_BATCH,
} from './rawBodies.js';

export interface FetchArgs {
	readonly set: string;
	readonly itemsToken: string;
	readonly byUid: boolean;
}

/** Octet separators for splicing body literals into a FETCH response Buffer. */
const SPACE = Buffer.from(' ', 'ascii');
const CLOSE_PAREN = Buffer.from(')', 'ascii');

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
	requires: 'selected',
	parseArgs(rawArgs) {
		const [set, itemsToken] = rawArgs;
		if (!set || !itemsToken) {
			return { ok: false, error: 'FETCH requires <set> (items)' };
		}
		return { ok: true, args: { set, itemsToken, byUid: false } };
	},
	start({ deps, state, args, tag, send }) {
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
		const setsSeen = !state.selected!.readOnly && bodyRequests.some((b) => !b.peek);

		const label = args.byUid ? 'UID FETCH' : 'FETCH';

		return asyncSession(async () => {
			try {
				// Build the sequence ↔ UID map for the SELECTed folder, then
				// resolve the set against it. A non-UID set holds positions; a
				// UID set holds UIDs. Either way `resolved` is ordered by true
				// sequence number and carries the UID to fetch.
				const { resolved } = await resolveSelectedSet(deps, state, args.set, args.byUid);

				if (resolved.length === 0) {
					send(`${tag} OK ${label} completed`);
					return;
				}

				// Envelopes for the requested min..max UID window only, read in
				// bounded pages (`FETCH 1:*` on a large folder would otherwise be
				// one read of every document in it). Rows are indexed by UID so
				// each resolved {uid, seq} is emitted in true sequence order even
				// across gaps. `resolved` is ascending by sequence number, and so by
				// UID, so its ends are the window (no `Math.min(...uids)` spread,
				// which a whole-folder set could push past the argument limit).
				const slice = await loadEnvelopes(
					deps.convex,
					state.selected!.folderId,
					resolved[0]!.uid,
					resolved[resolved.length - 1]!.uid
				);
				const byUidMap = new Map<number, FetchEnvelope>();
				for (const m of slice) byUidMap.set(m.uid, m);

				let dropped = 0;
				const rows: Array<{ seq: number; m: FetchEnvelope }> = [];
				for (const { uid, seq } of resolved) {
					const m = byUidMap.get(uid);
					if (!m) {
						// The UID list and the envelope pages are separate reads, so a
						// concurrent EXPUNGE can retire a message between them. Dropping
						// it is right (it no longer exists), but silently dropping it is
						// how a paging bug would look too — say so in the log.
						dropped += 1;
						continue;
					}
					rows.push({ seq, m });
				}

				const emit = (
					{ seq, m }: { seq: number; m: FetchEnvelope },
					seenFlags: string | undefined,
					raw: Buffer | null
				): void => {
					const fields: string[] = [];
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

					// Body sections carry raw 8-bit/binary octets, so the whole
					// `* seq FETCH (...)` line is assembled as a Buffer: the
					// ASCII prose fields, then each body literal spliced in
					// verbatim. Sending it as a UTF-8 string would re-encode the
					// body and desync the declared `{N}` octet count.
					if (raw != null) {
						// The prose prefix keeps the UTF-8 text path (an ENVELOPE
						// subject/name may carry non-ASCII); only the appended
						// body literal is spliced in as verbatim raw octets.
						const parts: Buffer[] = [
							Buffer.from(
								`* ${seq} FETCH (${fields.length > 0 ? `${fields.join(' ')} ` : ''}`,
								'utf8'
							),
						];
						bodyRequests.forEach((req, i) => {
							if (i > 0) parts.push(SPACE);
							parts.push(formatBodySection(req, raw));
						});
						parts.push(CLOSE_PAREN);
						send(Buffer.concat(parts));
						return;
					}
					send(`* ${seq} FETCH (${fields.join(' ')})`);
				};

				if (!needsRaw) {
					for (const row of rows) emit(row, undefined, null);
				} else {
					// Per chunk: one \Seen write and one URL mint, side by side,
					// then the downloads in parallel and the responses in order.
					// The implicit \Seen still lands before the chunk's FLAGS are
					// emitted, so each response reflects the new flag set.
					for (let i = 0; i < rows.length; i += RAW_URL_BATCH) {
						const chunk = rows.slice(i, i + RAW_URL_BATCH);
						const ids = chunk.map(({ m }) => m._id);
						const [seen, urls] = await Promise.all([
							setsSeen
								? markSeenBatch(
										deps.convex,
										chunk.filter(({ m }) => !m.flagSeen).map(({ m }) => m._id)
									)
								: Promise.resolve(new Map<string, string>()),
							mintRawUrls(deps.convex, ids),
						]);
						await forEachOrdered(
							chunk,
							RAW_DOWNLOAD_CONCURRENCY,
							({ m }) => downloadRaw(urls.get(m._id)),
							(row, raw) => emit(row, seen.get(row.m._id), raw)
						);
					}
				}

				if (dropped > 0) {
					logger.warn({ dropped, label }, 'FETCH: resolved UIDs missing from envelope pages');
				}
				send(`${tag} OK ${label} completed`);
			} catch (err) {
				logger.error({ err }, 'FETCH failed');
				send(serverFailure(tag, label));
			}
		});
	},
};

/**
 * Render the message's flags as they will be after an implicit \Seen.
 * Used when the \Seen write did not report the row (it was already seen,
 * or it vanished) but the response must still carry FLAGS.
 */
function formatFlagsWithSeen(m: FetchEnvelope, setsSeen: boolean): string {
	const base = formatFlags(m);
	if (!setsSeen || m.flagSeen) return base;
	return base.length > 0 ? `\\Seen ${base}` : '\\Seen';
}
