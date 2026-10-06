/**
 * Attachments a composition was opened to carry (a generated iCalendar RSVP,
 * a forwarded message's files) that are not committed to its draft yet (#1257).
 *
 * Until each one is on the row, the only other copy is an upload in flight,
 * which a reload or a leave ends. So the draft keeps a record of them here, in
 * session state and in this tab's sessionStorage (a reload keeps it), keyed by
 * the draft: whatever reopens that draft (the compose page from its URL, Answer
 * mode from `&draft=`, Drafts) finds what is still owed and attaches it again.
 *
 * Per file the record holds:
 *
 *   - `pending`, until it is on the row; `done` once it is; `dropped` when it
 *     never will be (the person removed its chip, a compose limit refused it,
 *     its source could not be read);
 *   - `storageId`, written BEFORE the attach is sent. An attach that was in
 *     flight when the page went may still land, so a reopen attaches that same
 *     upload again (`drafts.addAttachment` takes an upload the draft already
 *     holds as done) instead of uploading a second copy.
 *
 * A generated file is kept whole (it cannot be made again); a forward keeps
 * only the message it copies from. Every write after a mount `claim`s the
 * record names that mount, so a composer that has gone, and whose upload
 * finishes late, cannot attach behind the one that took the draft over.
 *
 * A settled record keeps no content and stays as a marker until it expires,
 * so a remount that still carries the open's instructions does not run them
 * a second time.
 */
import type { Id } from '@owlat/api/dataModel';

/** A file the app made for the composer to attach (plain text content). */
export interface GeneratedAttachment {
	filename: string;
	contentType: string;
	content: string;
}

export type ExpectedSource =
	| { kind: 'generated'; attachment: GeneratedAttachment }
	| { kind: 'forward'; messageId: Id<'mailMessages'> };

export interface ExpectedFile {
	filename: string;
	contentType: string;
	size: number;
	state: 'pending' | 'done' | 'dropped';
	/** The upload, recorded before its attach is sent. */
	storageId?: string;
}

export interface ExpectedEntry {
	source: ExpectedSource;
	/** Null until the source has been read (a forward's files are not known before). */
	files: ExpectedFile[] | null;
}

export interface ExpectedRecord {
	v: 1;
	createdAt: number;
	/** The composer mount that works on the record now. */
	owner: string | null;
	entries: ExpectedEntry[];
	/** Every file is on the row or dropped; the entries are gone. */
	settled?: true;
}

const STORAGE_PREFIX = 'owlat:compose-expected:';
/** As long as a compose request lives. */
export const EXPECTED_RECORD_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Above this a record is kept in session state only. A generated RSVP is a few
 * KB; the bound keeps one oversized file from filling this tab's storage.
 */
export const EXPECTED_RECORD_MAX_CHARS = 256 * 1024;

function storage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.sessionStorage;
	} catch {
		return null;
	}
}

function parse(raw: string | null): ExpectedRecord | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<ExpectedRecord> | null;
		return value && value.v === 1 && Array.isArray(value.entries)
			? (value as ExpectedRecord)
			: null;
	} catch {
		return null;
	}
}

/** Whether a record still owes the draft a file. */
export function expectedRecordOpen(record: ExpectedRecord | null): boolean {
	return !!record && !record.settled;
}

/** Every entry read and every file on the row or dropped. */
function expectedRecordComplete(record: ExpectedRecord): boolean {
	return record.entries.every(
		(entry) => entry.files !== null && entry.files.every((file) => file.state !== 'pending')
	);
}

export function usePostboxExpectedAttachments() {
	const records = useState<Record<string, ExpectedRecord>>('postbox:compose-expected', () => ({}));

	function write(draftId: string, record: ExpectedRecord) {
		records.value = { ...records.value, [draftId]: record };
		const store = storage();
		if (!store) return;
		try {
			const json = JSON.stringify(record);
			if (json.length <= EXPECTED_RECORD_MAX_CHARS) store.setItem(STORAGE_PREFIX + draftId, json);
			else store.removeItem(STORAGE_PREFIX + draftId);
		} catch {
			// Quota or serialization trouble: the session copy still stands.
		}
	}

	function pruneExpired(now: number) {
		const store = storage();
		if (!store) return;
		try {
			for (let i = store.length - 1; i >= 0; i -= 1) {
				const key = store.key(i);
				if (!key?.startsWith(STORAGE_PREFIX)) continue;
				const record = parse(store.getItem(key));
				if (!record || now - record.createdAt > EXPECTED_RECORD_TTL_MS) store.removeItem(key);
			}
		} catch {
			// Best effort.
		}
	}

	function read(draftId: string): ExpectedRecord | null {
		const record =
			records.value[draftId] ?? parse(storage()?.getItem(STORAGE_PREFIX + draftId) ?? null);
		if (!record || Date.now() - record.createdAt > EXPECTED_RECORD_TTL_MS) return null;
		return record;
	}

	/**
	 * The draft was made to carry `sources`: record them, unless it already has
	 * a record (a remount of the same open finds its own, settled or not).
	 */
	function begin(draftId: string, sources: ExpectedSource[]) {
		if (sources.length === 0 || read(draftId)) return;
		const now = Date.now();
		pruneExpired(now);
		write(draftId, {
			v: 1,
			createdAt: now,
			owner: null,
			entries: sources.map((source) => ({ source, files: null })),
		});
	}

	/** This mount takes the record over; returns it as it stands. */
	function claim(draftId: string, owner: string): ExpectedRecord | null {
		const record = read(draftId);
		if (!record) return null;
		const claimed = { ...record, owner };
		write(draftId, claimed);
		return claimed;
	}

	/**
	 * Change the record, only while `owner` still holds it. A change that leaves
	 * nothing owed settles it. False when fenced off (or there is no record).
	 */
	function update(
		draftId: string,
		owner: string,
		change: (record: ExpectedRecord) => ExpectedRecord
	): boolean {
		const record = read(draftId);
		if (!record || record.owner !== owner || record.settled) return false;
		const next = change(record);
		write(
			draftId,
			expectedRecordComplete(next)
				? { v: 1, createdAt: next.createdAt, owner, entries: [], settled: true }
				: next
		);
		return true;
	}

	return { read, begin, claim, update };
}
