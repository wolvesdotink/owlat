/**
 * "Download all my mail" (idea 50) — the client half.
 *
 * Walks `mail.mailbox.rawExport.listRawMessageUrls` page by page, fetches each
 * message's original `.eml`, and appends it to an mbox archive that is written
 * STRAIGHT TO THE DESTINATION as it goes (the same OPFS / save-picker sink the
 * JSON account export streams through). At no point does a whole mailbox exist
 * in a variable: peak memory is one message.
 *
 * Bytes are decoded as latin1 — one char per byte — exactly as `loadRawEml`
 * decodes a single message for the reader. A message is MIME, not text: parts
 * carry their own charsets and attachments are arbitrary bytes, so decoding the
 * container as UTF-8 would mangle everything the archive is for.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { serializeMboxEntry } from '@owlat/shared/mboxArchive';
import type { ConvexClient } from 'convex/browser';
import type { TextChunkSink } from './incrementalJsonSerializer';

/** Live counters for the progress readout while an export runs. */
export interface MboxExportProgress {
	messages: number;
}

/** The one file name the export offers, dated so repeated exports don't collide. */
export function mboxExportFilename(now: Date): string {
	return `owlat-mail-${now.toISOString().slice(0, 10)}.mbox`;
}

async function fetchRawMessage(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) throw new Error('Could not download a message for the mail archive');
	return new TextDecoder('latin1').decode(new Uint8Array(await response.arrayBuffer()));
}

/**
 * Stream the caller's whole mailbox into `sink` as an mbox archive.
 *
 * Returns the number of messages written. On failure the sink is aborted, so a
 * half-written archive is never handed to the user as if it were complete.
 */
export async function writeMailboxMboxExport(
	client: ConvexClient,
	mailboxId: Id<'mailboxes'>,
	sink: TextChunkSink,
	onProgress?: (progress: MboxExportProgress) => void
): Promise<number> {
	let messages = 0;
	try {
		let cursor: string | undefined;
		const seenCursors = new Set<string>();
		for (;;) {
			const page = await client.action(api.mail.mailbox.rawExport.listRawMessageUrls, {
				mailboxId,
				...(cursor ? { cursor } : {}),
			});
			for (const message of page.messages) {
				const raw = await fetchRawMessage(message.url);
				await sink.write(
					serializeMboxEntry(raw, {
						address: message.fromAddress,
						receivedAt: message.receivedAt,
					})
				);
				messages++;
				onProgress?.({ messages });
			}
			if (page.isDone) break;
			// The same guard the JSON export uses: a cursor that repeats would
			// otherwise re-download the same page until the disk fills.
			if (!page.continueCursor || seenCursors.has(page.continueCursor)) {
				throw new Error('Mail export pagination did not advance');
			}
			seenCursors.add(page.continueCursor);
			cursor = page.continueCursor;
		}
		await sink.close();
		return messages;
	} catch (error) {
		try {
			await sink.abort(error);
		} catch {
			// Preserve the export failure even if rolling back the destination fails.
		}
		throw error;
	}
}
