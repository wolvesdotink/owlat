import { logger } from '../../logger.js';
import { parseList } from '../../parser.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession } from '../helpers/session.js';
import { resolveSelectedSet, uidRuns } from '../helpers/seqMap.js';
import { streamEnvelopes } from '../helpers/folderPaging.js';
import { type FetchEnvelope, formatEnvelope, formatFlags, formatInternalDate } from './format.js';
import { type BodySectionRequest, bodySectionParts, parseBodySectionItem } from './bodySection.js';
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
 *
 * Output is paced by the socket: after each response the module waits for
 * `deps.waitForDrain`, and the ordered download loop only starts the next
 * body once the response ahead of it has been taken. A slow reader therefore
 * holds at most the output budget plus {@link RAW_DOWNLOAD_CONCURRENCY}
 * bodies, not the whole requested mailbox. When the connection closes the
 * session is cancelled: no further Convex pages, \Seen writes, URL mints or
 * downloads are issued, in-flight downloads are aborted, and nothing more is
 * sent.
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

		return asyncSession(async (signal) => {
			/**
			 * Pace output: when the socket is over its budget, a promise that
			 * settles once it has taken what was sent (rejecting if the
			 * connection went meanwhile); otherwise nothing to wait for.
			 */
			const paced = (): Promise<void> | undefined => {
				const wait = deps.waitForDrain?.();
				return wait?.then(() => signal.throwIfAborted());
			};
			try {
				// Build the sequence ↔ UID map for the SELECTed folder, then
				// resolve the set against it. A non-UID set holds positions; a
				// UID set holds UIDs. Either way `resolved` is ordered by true
				// sequence number and carries the UID to fetch.
				const { resolved } = await resolveSelectedSet(deps, state, args.set, args.byUid, signal);

				if (resolved.length === 0) {
					send(`${tag} OK ${label} completed`);
					return;
				}

				const emit = (
					{ seq, m }: { seq: number; m: FetchEnvelope },
					seenFlags: string | undefined,
					raw: Buffer | null
				): Promise<void> | undefined => {
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
						// body literal is spliced in as verbatim raw octets. The
						// section octets are views into `raw`, so the one concat
						// below is the only copy of the body; the pump writes it
						// and the CRLF without copying again.
						const parts: Buffer[] = [
							Buffer.from(
								`* ${seq} FETCH (${fields.length > 0 ? `${fields.join(' ')} ` : ''}`,
								'utf8'
							),
						];
						bodyRequests.forEach((req, i) => {
							if (i > 0) parts.push(SPACE);
							parts.push(...bodySectionParts(req, raw));
						});
						parts.push(CLOSE_PAREN);
						send(Buffer.concat(parts));
					} else {
						send(`* ${seq} FETCH (${fields.join(' ')})`);
					}
					return paced();
				};

				type Row = { seq: number; m: FetchEnvelope };
				// Per chunk: one \Seen write and one URL mint, side by side,
				// then the downloads in parallel and the responses in order.
				// The implicit \Seen still lands before the chunk's FLAGS are
				// emitted, so each response reflects the new flag set.
				const sendChunk = async (chunk: Row[]): Promise<void> => {
					// A cancelled FETCH marks nothing \Seen and mints nothing
					// past the chunk it was on.
					signal.throwIfAborted();
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
						({ m }) => downloadRaw(urls.get(m._id), signal),
						(row, raw) => emit(row, seen.get(row.m._id), raw),
						signal
					);
				};

				// Envelopes for exactly the requested messages: one UID range
				// per run of consecutive sequence numbers, so a sparse set reads
				// the rows it names rather than its min..max span. Pages are
				// matched against `resolved` (both ascending by UID) and sent as
				// they arrive — the first response does not wait for the last
				// page, and the sidecar holds one page and one chunk, not the set.
				let next = 0;
				let dropped = 0;
				let chunk: Row[] = [];
				const pages = streamEnvelopes(
					deps.convex,
					state.selected!.folderId,
					uidRuns(resolved),
					resolved.length,
					signal
				);
				for await (const page of pages) {
					for (const m of page) {
						// The UID list and the envelope pages are separate reads, so
						// a concurrent EXPUNGE can retire a message between them.
						// Dropping it is right (it no longer exists), but silently
						// dropping it is how a paging bug would look too — it is
						// counted and logged below.
						while (next < resolved.length && resolved[next]!.uid < m.uid) {
							dropped += 1;
							next += 1;
						}
						const target = resolved[next];
						if (target === undefined || target.uid !== m.uid) continue;
						next += 1;
						const row: Row = { seq: target.seq, m };
						if (!needsRaw) {
							signal.throwIfAborted();
							const wait = emit(row, undefined, null);
							if (wait) await wait;
						} else {
							chunk.push(row);
							if (chunk.length === RAW_URL_BATCH) {
								await sendChunk(chunk);
								chunk = [];
							}
						}
					}
				}
				if (chunk.length > 0) await sendChunk(chunk);
				dropped += resolved.length - next;

				if (dropped > 0) {
					logger.warn({ dropped, label }, 'FETCH: resolved UIDs missing from envelope pages');
				}
				send(`${tag} OK ${label} completed`);
			} catch (err) {
				// The connection is gone: nobody is left to answer.
				if (signal.aborted) return;
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
