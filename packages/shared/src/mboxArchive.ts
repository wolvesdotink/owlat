/**
 * mbox archive format — the one wire format every mail client agrees on.
 *
 * Two halves, both pure and both byte-exact, shared by the import job in
 * `apps/api/convex/mail/archiveImport*.ts` and the "download all my mail"
 * export in `apps/web/app/utils/mboxExport.ts`:
 *
 *  - {@link MboxSplitter} cuts an archive into individual RFC 5322 messages
 *    INCREMENTALLY, chunk by chunk, and reports the byte offset each message
 *    started and ended at. Those offsets are what make a multi-hour import
 *    resumable: the job row stores the offset of the last message it committed,
 *    and a later run re-opens the archive and starts the splitter there.
 *  - {@link serializeMboxEntry} writes one message back out with its `From_`
 *    separator line and mboxrd quoting.
 *
 * OFFSETS ARE BYTES, and the caller keeps them honest by decoding the archive
 * as latin1 (one char per byte), exactly as `loadRawEml` already decodes a
 * single `.eml`. Decoding as UTF-8 would collapse multi-byte sequences into one
 * char and every recorded offset would drift.
 *
 * Quoting is mboxrd (`From ` → `>From `, `>From ` → `>>From `), which is the
 * only variant that round-trips: mboxo cannot distinguish a body line that was
 * quoted from one that was always `>From `.
 */

/**
 * Largest archive one import job accepts, in bytes.
 *
 * Lives here rather than in the Convex module that enforces it because the
 * upload form has to refuse an over-size file BEFORE spending the user's
 * bandwidth on it, and a client-side ceiling that disagrees with the server's is
 * either a wasted upload or a promise the server breaks.
 *
 * 64 MiB is what one action can hold: the runner re-reads the uploaded blob on
 * every pass (that is what makes a resumed pass a byte offset rather than
 * carried state). A larger export splits into several files, which Google
 * Takeout already does on its own.
 */
export const MAX_ARCHIVE_IMPORT_BYTES = 64 * 1024 * 1024;

/** Line that opens a message in an mbox archive. */
const FROM_PREFIX = 'From ';

/**
 * A `From_` line, permissively: the prefix, an optional envelope sender, then
 * a timestamp. The real guard against a body line masquerading as a separator
 * is the blank line before it (see {@link isEntryBoundary}); this only rejects
 * the obvious non-separators ("From now on, ...").
 */
const FROM_LINE = /^From (\S*) (.+)$/;

/**
 * Strict variant, required when the candidate is NOT preceded by a blank line.
 * Both Gmail Takeout (`From 15…@xxx Mon Jan 01 00:00:00 +0000 2018`) and the
 * classic asctime form lead with a weekday, so an archive that omits the blank
 * separator line is still splittable without opening the door to arbitrary
 * body text.
 */
const STRICT_FROM_LINE = /^From (\S*) (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) .+$/;

/** Envelope sender recorded when a message has no usable address. */
const MBOX_UNKNOWN_SENDER = 'MAILER-DAEMON';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
] as const;

function pad2(value: number): string {
	return String(value).padStart(2, '0');
}

/**
 * The asctime timestamp of a `From_` line, in UTC.
 *
 * Deliberately hand-rolled rather than `toDateString()`: the separator line is
 * a wire format, so it must not follow the exporting user's locale or zone.
 */
function mboxTimestamp(receivedAt: number): string {
	const date = new Date(receivedAt);
	const day = WEEKDAYS[date.getUTCDay()] ?? 'Thu';
	const month = MONTHS[date.getUTCMonth()] ?? 'Jan';
	const dayOfMonth = String(date.getUTCDate()).padStart(2, ' ');
	const time = `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
	return `${day} ${month} ${dayOfMonth} ${time} ${date.getUTCFullYear()}`;
}

/**
 * The envelope sender as a `From_` line can carry it: no whitespace (it is a
 * space-delimited field) and no angle brackets. Empty input becomes
 * {@link MBOX_UNKNOWN_SENDER} rather than an empty field, so the line still has
 * the shape every reader expects.
 */
function mboxEnvelopeSender(address: string | undefined): string {
	const cleaned = (address ?? '').replace(/[<>]/g, '').trim().split(/\s+/)[0] ?? '';
	return cleaned || MBOX_UNKNOWN_SENDER;
}

/** The full `From_` separator line (no trailing newline). */
function mboxFromLine(address: string | undefined, receivedAt: number): string {
	return `${FROM_PREFIX}${mboxEnvelopeSender(address)} ${mboxTimestamp(receivedAt)}`;
}

/** mboxrd quoting: every `From `/`>From `/`>>From ` body line gains one `>`. */
function quoteMboxBody(raw: string): string {
	return raw.replace(/^(>*From )/gm, '>$1');
}

/** Inverse of {@link quoteMboxBody}. */
function unquoteMboxBody(raw: string): string {
	return raw.replace(/^>(>*From )/gm, '$1');
}

/**
 * One message ready to append to an archive: the `From_` line, the quoted
 * message, and the blank line that separates it from the next entry. Always
 * ends with `\n\n` so entries concatenate without the caller thinking about it.
 */
export function serializeMboxEntry(
	raw: string,
	options: { address?: string; receivedAt: number }
): string {
	const body = quoteMboxBody(raw.endsWith('\n') ? raw : `${raw}\n`);
	return `${mboxFromLine(options.address, options.receivedAt)}\n${body}\n`;
}

/** A message cut out of an archive, with the byte range it occupied. */
export interface MboxEntry {
	/** RFC 5322 message with the `From_` line removed and quoting undone. */
	raw: string;
	/** Envelope sender from the `From_` line ({@link MBOX_UNKNOWN_SENDER} when absent). */
	envelopeSender: string;
	/** Byte offset of this entry's `From_` line within the whole archive. */
	startOffset: number;
	/** Byte offset one past this entry — where the next entry's `From_` line begins. */
	endOffset: number;
}

/**
 * Whether the line starting at `index` opens a new entry.
 *
 * `precededByBlankLine` is the classic mbox rule and carries almost all of the
 * weight; the strict weekday form is the fallback for archives that write no
 * blank line before the separator.
 */
function isEntryBoundary(
	line: string,
	precededByBlankLine: boolean,
	atArchiveStart: boolean
): boolean {
	if (!line.startsWith(FROM_PREFIX)) return false;
	if (atArchiveStart || precededByBlankLine) return FROM_LINE.test(line);
	return STRICT_FROM_LINE.test(line);
}

/** Strip the single trailing blank line an mbox writer puts between entries. */
function trimEntryTail(body: string): string {
	if (body.endsWith('\n\n')) return body.slice(0, -1);
	return body;
}

/**
 * Incremental mbox reader.
 *
 * Feed it latin1-decoded chunks in order; it returns every entry it can close.
 * An entry is only closed once the NEXT boundary (or {@link flush}) is seen, so
 * a message split across two chunks is never truncated. `pendingOffset` is the
 * offset of the entry currently being accumulated — a caller that commits after
 * every batch stores it, and a resumed run constructs a new splitter at that
 * offset and re-reads from there.
 */
export class MboxSplitter {
	/** Buffered text not yet emitted, starting at {@link bufferOffset}. */
	private buffer = '';
	/** Archive byte offset of `buffer[0]`. */
	private bufferOffset: number;
	/** Start offset of the entry being accumulated, or null before the first one. */
	private entryStart: number | null = null;
	/** `From_` line of the entry being accumulated. */
	private entryFromLine = '';
	/** Body of the entry being accumulated (everything after its `From_` line). */
	private entryBody = '';

	constructor(startOffset = 0) {
		this.bufferOffset = startOffset;
	}

	/** Offset of the first byte not yet closed into an emitted entry. */
	get pendingOffset(): number {
		return this.entryStart ?? this.bufferOffset;
	}

	/** Consume a chunk, returning every entry that ends within it. */
	push(chunk: string): MboxEntry[] {
		this.buffer += chunk;
		const entries: MboxEntry[] = [];
		// Keep the trailing partial line buffered: a boundary can only be judged
		// once its whole line (and the newline that ends it) has arrived.
		let lineStart = 0;
		let newlineIndex = this.buffer.indexOf('\n', lineStart);
		// Only a genuine empty line qualifies. Right after a `From_` line the body
		// is empty too, but the line that follows is a header — never a separator.
		let precededByBlankLine = this.entryBody.endsWith('\n\n');
		while (newlineIndex !== -1) {
			const line = this.buffer.slice(lineStart, newlineIndex);
			const absoluteStart = this.bufferOffset + lineStart;
			const atArchiveStart = absoluteStart === 0 && this.entryStart === null;
			if (
				isEntryBoundary(line, this.entryStart === null ? true : precededByBlankLine, atArchiveStart)
			) {
				const closed = this.closeEntry(absoluteStart);
				if (closed) entries.push(closed);
				this.entryStart = absoluteStart;
				this.entryFromLine = line;
				this.entryBody = '';
				precededByBlankLine = false;
			} else if (this.entryStart !== null) {
				this.entryBody += `${line}\n`;
				precededByBlankLine = line === '';
			}
			lineStart = newlineIndex + 1;
			newlineIndex = this.buffer.indexOf('\n', lineStart);
		}
		this.buffer = this.buffer.slice(lineStart);
		this.bufferOffset += lineStart;
		return entries;
	}

	/** Close the final entry (the archive's last message has no boundary after it). */
	flush(): MboxEntry[] {
		if (this.buffer) {
			// A final line with no terminating newline: fold it into the open entry.
			if (this.entryStart !== null) this.entryBody += this.buffer;
			this.bufferOffset += this.buffer.length;
			this.buffer = '';
		}
		const closed = this.closeEntry(this.bufferOffset);
		this.entryStart = null;
		return closed ? [closed] : [];
	}

	private closeEntry(endOffset: number): MboxEntry | null {
		if (this.entryStart === null) return null;
		const match = FROM_LINE.exec(this.entryFromLine);
		const entry: MboxEntry = {
			raw: unquoteMboxBody(trimEntryTail(this.entryBody)),
			envelopeSender: mboxEnvelopeSender(match?.[1]),
			startOffset: this.entryStart,
			endOffset,
		};
		this.entryStart = null;
		this.entryFromLine = '';
		this.entryBody = '';
		return entry;
	}
}
