/**
 * On-device copies of unsent text in the conversation composers: the Team
 * inbox reply, internal notes, chat rooms, the Assistant and the other
 * message boxes that have no server-side draft row.
 *
 * It shares the IndexedDB driver and object store with the Postbox draft
 * mirror (`postboxDraftMirrorStore.ts`), as its own key family:
 *
 *   composer-draft:v1:<userId>:<kind>:<target>
 *
 * The mail mirror's key grammar and failure contract do not fit here: its
 * segments are colon-free mail ids, and it is a second copy of text the server
 * also autosaves. These drafts have NO other copy, so nothing here may claim a
 * write landed when it did not (`write` reports whether it committed), and a
 * device without IndexedDB keeps them for the page's lifetime only.
 *
 * Namespaced by the signed-in user: one person's unsent text is never offered
 * to another on a shared browser. `userId` and `target` are URI-encoded, so a
 * target such as `team:<threadId>` keeps the key's four segments apart.
 *
 * Pure data layer: no Vue, no DOM, no network.
 */

import { sameStoredValue } from './postboxDraftMirror';
import { getOfflineKvDriver, type OfflineKvDriver } from './postboxOfflineKvDriver';

const PREFIX = 'composer-draft:v1:';

/** A file already uploaded for a chat message, kept with the unsent text. */
export interface ChatDraftAttachment {
	id: string;
	filename: string;
	mimeType: string;
}

/** What each composer keeps, by kind. */
export interface ComposerDraftFieldsByKind {
	/** The Team inbox reply (Inbox page and Answer mode). Target: the thread. */
	'team-reply': { body: string; subject: string; gapGuarded?: boolean };
	/** The team composer's internal note. Target: its draft key (`team:<id>`, `mail:<id>`). */
	'team-note': { body: string; itemId: string | null };
	/** Answer mode's new internal note. Target: the thread. */
	'answer-note': { body: string };
	/** A chat room's message and the files uploaded for it. Target: the room. */
	chat: { text: string; attachments: ChatDraftAttachment[] };
	/** The Assistant's question. Target: `assistant` (one composer). */
	assistant: { text: string };
	/** A shared mailbox thread's reply, before it goes to the composer. Target: the thread. */
	'mail-reply': { text: string };
	/** A mail thread's discussion message. Target: `<mailboxId>:<threadId>`. */
	'mail-discussion': { text: string };
	/** A reply on another channel (SMS, WhatsApp). Target: the thread. */
	'channel-reply': { text: string; replyToId: string };
	/** A message to a contact from their timeline. Target: the contact. */
	'contact-message': { text: string };
}

export type ComposerDraftKind = keyof ComposerDraftFieldsByKind;
export type ComposerDraftFields<K extends ComposerDraftKind = ComposerDraftKind> =
	ComposerDraftFieldsByKind[K];

interface KindSpec<K extends ComposerDraftKind> {
	/** The stored fields, or null when they are not this kind's shape. */
	parse: (value: Record<string, unknown>) => ComposerDraftFields<K> | null;
	/** Nothing left to keep: the draft is deleted rather than stored. */
	isEmpty: (fields: ComposerDraftFields<K>) => boolean;
	/** Something a person would call a draft (drives the row markers). */
	hasContent: (fields: ComposerDraftFields<K>) => boolean;
}

const isString = (value: unknown): value is string => typeof value === 'string';

function textOnly<K extends ComposerDraftKind>(): KindSpec<K> {
	return {
		parse: (value) => (isString(value['text']) ? ({ text: value['text'] } as never) : null),
		isEmpty: (fields) => (fields as { text: string }).text === '',
		hasContent: (fields) => (fields as { text: string }).text.trim() !== '',
	};
}

function parseAttachments(value: unknown): ChatDraftAttachment[] | null {
	if (!Array.isArray(value)) return null;
	const attachments: ChatDraftAttachment[] = [];
	for (const item of value) {
		if (typeof item !== 'object' || item === null) return null;
		const { id, filename, mimeType } = item as Record<string, unknown>;
		if (!isString(id) || !isString(filename) || !isString(mimeType)) return null;
		attachments.push({ id, filename, mimeType });
	}
	return attachments;
}

const KINDS: { [K in ComposerDraftKind]: KindSpec<K> } = {
	'team-reply': {
		parse: (value) =>
			isString(value['body']) && isString(value['subject'])
				? {
						body: value['body'],
						subject: value['subject'],
						...(value['gapGuarded'] === true ? { gapGuarded: true } : {}),
					}
				: null,
		// A reply of blanks is no reply (the Team inbox kept text always worked this way).
		isEmpty: (fields) => fields.body.trim() === '',
		hasContent: (fields) => fields.body.trim() !== '',
	},
	'team-note': {
		parse: (value) =>
			isString(value['body']) && (value['itemId'] === null || isString(value['itemId']))
				? { body: value['body'], itemId: value['itemId'] }
				: null,
		isEmpty: (fields) => fields.body === '' && fields.itemId === null,
		hasContent: (fields) => fields.body.trim() !== '',
	},
	'answer-note': {
		parse: (value) => (isString(value['body']) ? { body: value['body'] } : null),
		isEmpty: (fields) => fields.body === '',
		hasContent: (fields) => fields.body.trim() !== '',
	},
	chat: {
		parse: (value) => {
			const attachments = parseAttachments(value['attachments']);
			return isString(value['text']) && attachments ? { text: value['text'], attachments } : null;
		},
		isEmpty: (fields) => fields.text === '' && fields.attachments.length === 0,
		hasContent: (fields) => fields.text.trim() !== '' || fields.attachments.length > 0,
	},
	assistant: textOnly(),
	'mail-reply': textOnly(),
	'mail-discussion': textOnly(),
	'channel-reply': {
		parse: (value) =>
			isString(value['text']) && isString(value['replyToId'])
				? { text: value['text'], replyToId: value['replyToId'] }
				: null,
		// An open reply box is kept even while empty: it says which message it answers.
		isEmpty: (fields) => fields.replyToId === '',
		hasContent: (fields) => fields.text.trim() !== '',
	},
	'contact-message': textOnly(),
};

function isKind(value: string): value is ComposerDraftKind {
	return Object.hasOwn(KINDS, value);
}

/** Whether these fields hold nothing worth keeping (they are deleted instead). */
export function isComposerDraftEmpty<K extends ComposerDraftKind>(
	kind: K,
	fields: ComposerDraftFields<K>
): boolean {
	return KINDS[kind].isEmpty(fields);
}

/** Whether these fields are a draft a person would want pointed out. */
export function composerDraftHasContent<K extends ComposerDraftKind>(
	kind: K,
	fields: ComposerDraftFields<K>
): boolean {
	return KINDS[kind].hasContent(fields);
}

/** Unsent drafts are dropped after this long untouched. */
export const COMPOSER_DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many drafts per person on one device; the oldest go first. */
export const COMPOSER_DRAFT_CAP = 200;

/** One stored draft. */
interface ComposerDraftRecord {
	v: 1;
	savedAt: number;
	fields: Record<string, unknown>;
}

/** A draft loaded from the device. */
export interface LoadedComposerDraft {
	kind: ComposerDraftKind;
	target: string;
	savedAt: number;
	fields: ComposerDraftFields;
}

/** The storage key of one person's draft in one composer. */
export function composerDraftKey(userId: string, kind: ComposerDraftKind, target: string): string {
	return `${PREFIX}${encodeURIComponent(userId)}:${kind}:${encodeURIComponent(target)}`;
}

function parseKey(
	key: string,
	userPrefix: string
): { kind: ComposerDraftKind; target: string } | null {
	if (!key.startsWith(userPrefix)) return null;
	const parts = key.slice(userPrefix.length).split(':');
	if (parts.length !== 2) return null;
	const [kind, encodedTarget] = parts as [string, string];
	if (!isKind(kind)) return null;
	try {
		return { kind, target: decodeURIComponent(encodedTarget) };
	} catch {
		return null;
	}
}

function parseRecord(
	kind: ComposerDraftKind,
	value: unknown
): LoadedComposerDraft['fields'] | null {
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Partial<ComposerDraftRecord>;
	if (record.v !== 1 || typeof record.savedAt !== 'number') return null;
	if (typeof record.fields !== 'object' || record.fields === null) return null;
	const fields = KINDS[kind].parse(record.fields as Record<string, unknown>);
	if (!fields || KINDS[kind].isEmpty(fields as never)) return null;
	return fields;
}

export class ComposerDraftStore {
	private readonly driver: OfflineKvDriver;

	constructor(driver: OfflineKvDriver) {
		this.driver = driver;
	}

	/** False when nothing written here is actually stored (no IndexedDB). */
	get persistent(): boolean {
		return this.driver.persistent !== false;
	}

	/** Store one draft. True only when its transaction committed on a real store. */
	async write(key: string, fields: ComposerDraftFields, savedAt: number): Promise<boolean> {
		if (!this.persistent) return false;
		const record: ComposerDraftRecord = { v: 1, savedAt, fields: { ...fields } };
		try {
			await this.driver.set(key, record);
			return true;
		} catch {
			return false;
		}
	}

	/** Delete one draft (it was sent, cleared or discarded). */
	async remove(key: string): Promise<boolean> {
		try {
			await this.driver.delete(key);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Every draft this person kept on the device, newest first. Malformed
	 * records, drafts past the retention window and the oldest beyond the cap
	 * are deleted on the way, each only if the stored value is still the one
	 * that was read (a newer write in between survives). `skip` names drafts
	 * the caller already holds newer text for: they are neither returned nor
	 * expired.
	 */
	async load(
		userId: string,
		now: number,
		skip: (kind: ComposerDraftKind, target: string) => boolean
	): Promise<LoadedComposerDraft[]> {
		const userPrefix = `${PREFIX}${encodeURIComponent(userId)}:`;
		let keys: string[];
		try {
			keys = await this.driver.keys();
		} catch {
			return [];
		}
		const drafts: Array<LoadedComposerDraft & { key: string; raw: unknown }> = [];
		for (const key of keys) {
			const located = parseKey(key, userPrefix);
			if (!located || skip(located.kind, located.target)) continue;
			let raw: unknown;
			try {
				raw = await this.driver.get<unknown>(key);
			} catch {
				continue;
			}
			const fields = parseRecord(located.kind, raw);
			if (!fields) {
				await this.removeIfUnchanged(key, raw);
				continue;
			}
			const savedAt = (raw as ComposerDraftRecord).savedAt;
			drafts.push({ ...located, key, raw, savedAt, fields });
		}
		drafts.sort((a, b) => b.savedAt - a.savedAt);
		const kept: LoadedComposerDraft[] = [];
		for (const draft of drafts) {
			const expired = now - draft.savedAt > COMPOSER_DRAFT_RETENTION_MS;
			if (expired || kept.length >= COMPOSER_DRAFT_CAP) {
				await this.removeIfUnchanged(draft.key, draft.raw);
				continue;
			}
			kept.push({
				kind: draft.kind,
				target: draft.target,
				savedAt: draft.savedAt,
				fields: draft.fields,
			});
		}
		return kept;
	}

	private async removeIfUnchanged(key: string, expected: unknown): Promise<void> {
		const unchanged = (current: unknown) => sameStoredValue(current, expected);
		try {
			if (this.driver.deleteIf) {
				await this.driver.deleteIf(key, unchanged);
				return;
			}
			if (unchanged(await this.driver.get<unknown>(key))) await this.driver.delete(key);
		} catch {
			// Retention is best effort: the next load tries again.
		}
	}
}

let singleton: ComposerDraftStore | null = null;

/** The shared composer-draft store for this page. */
export function getComposerDraftStore(): ComposerDraftStore {
	if (!singleton) singleton = new ComposerDraftStore(getOfflineKvDriver());
	return singleton;
}
