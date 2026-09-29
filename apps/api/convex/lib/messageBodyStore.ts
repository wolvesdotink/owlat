/**
 * messageBodyStore — where a `mailMessages` row's INLINE body lives (plan 3.2).
 *
 * Convex reads whole documents, so every query that touched a message row, even
 * to count it or to render one list line, used to pay for up to 2 × 64 KB of
 * sealed body text. The inline bodies therefore live in their own 1:1 table,
 * `mailMessageBodies`, and only the readers that actually render or analyse a
 * body load that row.
 *
 * WIDEN → MIGRATE → NARROW. New writes go to `mailMessageBodies` only. Rows
 * written before this change still carry `textBodyInline` / `htmlBodyInline` on
 * the message itself until `migrations/0049_move_message_bodies` moves them, so
 * every reader here resolves "the body row, else the legacy columns". Dropping
 * the legacy columns from the schema is a follow-up once the migration has run
 * everywhere.
 *
 * Sealing is unchanged: the values stored here are exactly what used to be
 * stored on the row (sealed with `sealBodyAtWrite`), and every plaintext reader
 * still unseals through the `lib/messageBody.ts` accessors. The large-body blob
 * ids (`*BodyStorageId`) and the `searchBody` excerpt stay on `mailMessages`:
 * the ids are a few bytes and back the sharing-aware reseal/purge indexes, and
 * the `search_message_bodies` search index needs its filter fields (mailbox,
 * folder, sender, flags) on the same document as the searched text.
 *
 * Part of the lib/messageBody*.ts accessor family, so it is excluded from
 * `scripts/check-body-access.sh`.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { DatabaseReader, DatabaseWriter } from '../_generated/server';
import {
	openMailMessageInlineBody,
	openMailMessageRow,
	sealBodyAtWriteMaybe,
	type MailMessageInlineBody,
	type MailMessageInlineFields,
} from './messageBody';

/** A stored message row as far as its inline body is concerned. */
type StoredInlineRow = MailMessageInlineFields & { _id: Id<'mailMessages'> };

function findBodyRow(
	db: DatabaseReader,
	messageId: Id<'mailMessages'>
): Promise<Doc<'mailMessageBodies'> | null> {
	return db
		.query('mailMessageBodies')
		.withIndex('by_message', (q) => q.eq('messageId', messageId))
		.unique();
}

/**
 * The STORED (still sealed) inline body of a message: its `mailMessageBodies`
 * row, else the legacy columns on the row itself.
 */
export async function loadStoredInlineBody(
	db: DatabaseReader,
	row: StoredInlineRow
): Promise<MailMessageInlineFields> {
	const body = await findBodyRow(db, row._id);
	if (body === null)
		return { textBodyInline: row.textBodyInline, htmlBodyInline: row.htmlBodyInline };
	return { textBodyInline: body.textBodyInline, htmlBodyInline: body.htmlBodyInline };
}

/**
 * The row with its inline body attached in the legacy column shape, still
 * sealed. For readers that hand the row on to code that opens (or exports) the
 * body itself: AI transcripts, the account export. Only keys that hold a value
 * are set, so an absent body never travels as a present `undefined`.
 */
export async function withStoredInlineBody<T extends StoredInlineRow>(
	db: DatabaseReader,
	row: T
): Promise<T> {
	const body = await findBodyRow(db, row._id);
	if (body === null) return row;
	const { textBodyInline: _legacyText, htmlBodyInline: _legacyHtml, ...rest } = row;
	return {
		...rest,
		...(body.textBodyInline !== undefined ? { textBodyInline: body.textBodyInline } : {}),
		...(body.htmlBodyInline !== undefined ? { htmlBodyInline: body.htmlBodyInline } : {}),
	} as T;
}

/** {@link withStoredInlineBody} over a list of rows, preserving order. */
export function withStoredInlineBodies<T extends StoredInlineRow>(
	db: DatabaseReader,
	rows: T[]
): Promise<T[]> {
	return Promise.all(rows.map((row) => withStoredInlineBody(db, row)));
}

/** Read AND UNSEAL a message's inline body (body table, else legacy columns). */
export async function openStoredInlineBody(
	db: DatabaseReader,
	row: StoredInlineRow
): Promise<MailMessageInlineBody> {
	return openMailMessageInlineBody(await loadStoredInlineBody(db, row));
}

/**
 * The row with its inline body attached AND unsealed, for a read that hands the
 * row to a client (the reader's by-id and thread reads). Same shape the web
 * reader has always rendered: `textBodyInline` / `htmlBodyInline` on the row.
 */
export async function openStoredMailMessageRow<T extends StoredInlineRow>(
	db: DatabaseReader,
	row: T
): Promise<T> {
	return openMailMessageRow(await withStoredInlineBody(db, row));
}

/** {@link openStoredMailMessageRow} over a list of rows, preserving order. */
export function openStoredMailMessageRows<T extends StoredInlineRow>(
	db: DatabaseReader,
	rows: T[]
): Promise<T[]> {
	return Promise.all(rows.map((row) => openStoredMailMessageRow(db, row)));
}

// ── Writers ──────────────────────────────────────────────────────────────────

/**
 * Store a new message's inline body, sealed at rest exactly as the row columns
 * were (`sealBodyAtWrite`). Call it in the same mutation that inserted the
 * message, right after the insert. A message whose body lives only in storage
 * blobs (or has none) gets no body row.
 */
export async function insertMessageBody(
	db: DatabaseWriter,
	messageId: Id<'mailMessages'>,
	plaintext: { text?: string; html?: string }
): Promise<void> {
	if (plaintext.text === undefined && plaintext.html === undefined) return;
	await db.insert('mailMessageBodies', {
		messageId,
		textBodyInline: await sealBodyAtWriteMaybe(plaintext.text),
		htmlBodyInline: await sealBodyAtWriteMaybe(plaintext.html),
	});
}

/**
 * Give an IMAP COPY its own body row: the stored (sealed) values of the source
 * are copied verbatim, so the copy reads exactly like its source. A legacy
 * source whose body is still on the row needs nothing here — the copy's insert
 * spread those columns already.
 */
export async function copyMessageBody(
	db: DatabaseWriter,
	fromMessageId: Id<'mailMessages'>,
	toMessageId: Id<'mailMessages'>
): Promise<void> {
	const source = await findBodyRow(db, fromMessageId);
	if (source === null) return;
	await db.insert('mailMessageBodies', {
		messageId: toMessageId,
		textBodyInline: source.textBodyInline,
		htmlBodyInline: source.htmlBodyInline,
	});
}

/** Delete a message's body row, if it has one. Called with the row's delete. */
export async function deleteMessageBody(
	db: DatabaseWriter,
	messageId: Id<'mailMessages'>
): Promise<void> {
	const body = await findBodyRow(db, messageId);
	if (body !== null) await db.delete(body._id);
}

/**
 * Backfill step (migration 0049): move one legacy row's inline body columns into
 * `mailMessageBodies` and clear them on the row. Idempotent: a row without
 * inline columns is left alone, and a row that already has a body row only has
 * its stale legacy columns cleared (the body row wins, as it does for readers).
 * Values go through `sealBodyAtWrite` like any new write — a no-op on an
 * already sealed value, a seal when the instance has a key — so the move never
 * widens the plaintext footprint. Returns whether the row changed.
 */
export async function moveLegacyInlineBody(
	db: DatabaseWriter,
	row: Doc<'mailMessages'>
): Promise<boolean> {
	if (row.textBodyInline === undefined && row.htmlBodyInline === undefined) return false;
	const existing = await findBodyRow(db, row._id);
	if (existing === null) {
		await db.insert('mailMessageBodies', {
			messageId: row._id,
			textBodyInline: await sealBodyAtWriteMaybe(row.textBodyInline),
			htmlBodyInline: await sealBodyAtWriteMaybe(row.htmlBodyInline),
		});
	}
	await db.patch(row._id, { textBodyInline: undefined, htmlBodyInline: undefined });
	return true;
}
