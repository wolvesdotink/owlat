/**
 * The composer's local draft mirror — the pure half (plan idea 7).
 *
 * Autosave is server-only on a 1.5s debounce, so a tab crash, a killed browser
 * or a device that fell off the network loses every keystroke since the last
 * `drafts.update`. The mirror writes the live compose fields into the on-device
 * store far more often than that, and on reopen offers them back.
 *
 * KEEP AND ASK. The mirror never decides on its own that a copy is stale. A
 * copy is removed only when (a) its fields equal the latest observed server
 * row, (b) a person resolves it (Restore, Keep saved version, Discard, Send),
 * or (c) retention expires it. Everything else is offered, newest first, and
 * Restore asks before it could overwrite newer saved text: when the row is not
 * provably the one the copy was taken against (`restoreNeedsConfirmation`).
 * No timestamps are ever compared with the server's, so device clock skew, the
 * order saves land in, and whether the composer was still open when a save was
 * acknowledged cannot lose text.
 *
 * Module scope: no Vue, no IndexedDB, no i18n. Persistence lives in
 * `postboxDraftMirrorStore.ts`, the wiring in `usePostboxComposeMirror.ts`.
 */

import type { DraftComposerMode, DraftFields } from './postboxDraftFields';

/**
 * The mirrored slice of composer state: everything a person types. Attachments
 * and the From identity are server-owned and never mirrored or restored.
 *
 * Unlike autosave's wire snapshot (`composeDraftFields`, which carries blocks
 * only in full mode so a simple-mode save never overwrites stored blocks), the
 * mirror always records the blocks the composer holds, in every mode, and the
 * row's blocks are normalized the same way. So the comparison is like for like.
 */
export interface MirrorFields {
	toAddresses: string[];
	ccAddresses: string[];
	bccAddresses: string[];
	subject: string;
	bodyHtml: string;
	/** Canonical JSON of the blocks array; null only for legacy entries that never recorded them. */
	bodyBlocks: string | null;
	composerMode: DraftComposerMode;
	followUpRemindAt: number | null;
}

/** The fields `MirrorFields` covers, for touched-field tracking and masks. */
export const MIRROR_FIELD_NAMES = [
	'toAddresses',
	'ccAddresses',
	'bccAddresses',
	'subject',
	'bodyHtml',
	'bodyBlocks',
	'composerMode',
	'followUpRemindAt',
] as const satisfies readonly (keyof MirrorFields)[];
export type MirrorFieldName = (typeof MIRROR_FIELD_NAMES)[number];

/** One stored copy, owned by the composer session that wrote it. */
export interface MirrorCopy {
	v: 2;
	fields: MirrorFields;
	/** The server row as last observed when this copy was written; null when there was none. */
	base: MirrorFields | null;
	/** Client clock: display ("from 14:32"), ordering between this device's copies, retention. */
	savedAt: number;
	/** The draft row this composition belongs to, once it has one. */
	draftId: string | null;
	/** The message a reply answers, so a fresh reply only offers its own copies. */
	inReplyTo: string | null;
	/**
	 * The fields that are real, when not all are: text parked before its row
	 * loaded. Only these are compared and restored; absent means all.
	 */
	present?: MirrorFieldName[];
}

/** A mirror entry written before v2 (one shared slot per draft key). */
export interface LegacyMirrorEntry {
	fields: DraftFields & { followUpRemindAt?: number | null };
	savedAt: number;
	serverEditedAt: number;
}

/** Copies older than this are expired on the next scan. */
export const MIRROR_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Copies kept per mailbox; the oldest beyond this are expired. */
export const MIRROR_CAP_PER_MAILBOX = 30;

/**
 * Blocks as canonical JSON: one serialization for the composer's and the row's,
 * keys sorted, so an editor that rebuilds a block in another key order is not
 * read as a different message.
 */
export function canonicalBlocks(blocks: readonly unknown[] | null | undefined): string {
	return stableStringify(blocks ?? []);
}

/** The row's stored blocks string, normalized like the composer's. */
function canonicalRowBlocks(raw: string | undefined): string {
	if (!raw) return '[]';
	try {
		return canonicalBlocks(JSON.parse(raw) as unknown[]);
	} catch {
		return '[]';
	}
}

/** The composer refs the mirror reads (anything with a `.value`). */
export interface MirrorFieldSources {
	toAddresses: { readonly value: string[] };
	ccAddresses: { readonly value: string[] };
	bccAddresses: { readonly value: string[] };
	subject: { readonly value: string };
	bodyHtml: { readonly value: string };
	bodyBlocks: { readonly value: readonly unknown[] };
	composerMode: { readonly value: DraftComposerMode };
	followUpRemindAt: { readonly value: number | null };
}

/** Snapshot the composer. Lists are copied so later edits cannot reach in. */
export function mirrorFieldsOf(sources: MirrorFieldSources): MirrorFields {
	return {
		toAddresses: [...sources.toAddresses.value],
		ccAddresses: [...sources.ccAddresses.value],
		bccAddresses: [...sources.bccAddresses.value],
		subject: sources.subject.value,
		bodyHtml: sources.bodyHtml.value,
		bodyBlocks: canonicalBlocks(sources.bodyBlocks.value),
		composerMode: sources.composerMode.value,
		followUpRemindAt: sources.followUpRemindAt.value,
	};
}

/** The composer refs a restore or merge writes (anything with a writable `.value`). */
export interface MirrorFieldTargets {
	toAddresses: { value: string[] };
	ccAddresses: { value: string[] };
	bccAddresses: { value: string[] };
	subject: { value: string };
	bodyHtml: { value: string };
	bodyBlocks: { value: unknown[] };
	composerMode: { value: DraftComposerMode };
	followUpRemindAt: { value: number | null };
}

/**
 * Put `names` of `fields` into the composer. Unknown (legacy) or malformed
 * blocks keep what the composer holds rather than blank it.
 */
export function applyMirrorFields(
	targets: MirrorFieldTargets,
	fields: MirrorFields,
	names: readonly MirrorFieldName[] = MIRROR_FIELD_NAMES
): void {
	for (const name of names) {
		if (name === 'bodyBlocks') {
			if (fields.bodyBlocks === null) continue;
			try {
				targets.bodyBlocks.value = JSON.parse(fields.bodyBlocks) as unknown[];
			} catch {
				// Malformed blocks: keep the composer's.
			}
		} else if (name === 'toAddresses' || name === 'ccAddresses' || name === 'bccAddresses') {
			targets[name].value = [...fields[name]];
		} else if (name === 'subject' || name === 'bodyHtml') {
			targets[name].value = fields[name];
		} else if (name === 'composerMode') {
			targets.composerMode.value = fields.composerMode;
		} else {
			targets.followUpRemindAt.value = fields.followUpRemindAt;
		}
	}
}

/** A plain copy for the store (IndexedDB cannot clone a reactive proxy). */
export function plainMirrorFields(fields: MirrorFields | null): MirrorFields | null {
	return fields ? (JSON.parse(JSON.stringify(fields)) as MirrorFields) : null;
}

/** The raw `drafts.get` row fields the mirror needs. */
export interface MirrorRowSource {
	toAddresses?: string[];
	ccAddresses?: string[];
	bccAddresses?: string[];
	subject?: string;
	bodyHtml?: string;
	bodyBlocks?: string;
	composerMode?: DraftComposerMode;
	followUpRemindAt?: number;
}

/** The server row, normalized like `mirrorFieldsOf` (same defaults hydration renders). */
export function mirrorFieldsOfRow(row: MirrorRowSource): MirrorFields {
	return {
		toAddresses: [...(row.toAddresses ?? [])],
		ccAddresses: [...(row.ccAddresses ?? [])],
		bccAddresses: [...(row.bccAddresses ?? [])],
		subject: row.subject ?? '',
		bodyHtml: row.bodyHtml ?? '',
		bodyBlocks: canonicalRowBlocks(row.bodyBlocks),
		composerMode: row.composerMode ?? 'simple',
		followUpRemindAt: row.followUpRemindAt ?? null,
	};
}

/** A legacy entry's fields; its blocks were only recorded in full mode. */
export function mirrorFieldsOfLegacy(entry: LegacyMirrorEntry): MirrorFields {
	const f = entry.fields;
	return {
		toAddresses: [...f.toAddresses],
		ccAddresses: [...f.ccAddresses],
		bccAddresses: [...f.bccAddresses],
		subject: f.subject,
		bodyHtml: f.bodyHtml,
		bodyBlocks: f.bodyBlocks === undefined ? null : canonicalRowBlocks(f.bodyBlocks),
		composerMode: f.composerMode,
		followUpRemindAt: f.followUpRemindAt ?? null,
	};
}

const EMPTY_HTML = /^(?:\s|<br\s*\/?>|<\/?(?:p|div|span)[^>]*>|&nbsp;)*$/i;

/** True when body HTML carries no actual content (an empty contenteditable). */
export function isBlankHtml(html: string): boolean {
	return EMPTY_HTML.test(html.trim());
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** One field, compared the way the whole-copy comparison does. */
export function mirrorFieldEqual(name: MirrorFieldName, a: MirrorFields, b: MirrorFields): boolean {
	switch (name) {
		case 'toAddresses':
		case 'ccAddresses':
		case 'bccAddresses':
			return sameList(a[name], b[name]);
		case 'bodyHtml':
			// An empty editor writes `<p></p>` where the row holds '': the same message.
			return a.bodyHtml === b.bodyHtml || (isBlankHtml(a.bodyHtml) && isBlankHtml(b.bodyHtml));
		case 'bodyBlocks':
			// Unknown (legacy) blocks cannot disagree with anything.
			return a.bodyBlocks === null || b.bodyBlocks === null || a.bodyBlocks === b.bodyBlocks;
		default:
			return a[name] === b[name];
	}
}

/** Does a (possibly partial) copy carry `fields`' text on every field it holds? */
export function copyMatches(
	copy: { fields: MirrorFields; present?: readonly MirrorFieldName[] },
	fields: MirrorFields
): boolean {
	return (copy.present ?? MIRROR_FIELD_NAMES).every((name) =>
		mirrorFieldEqual(name, copy.fields, fields)
	);
}

/** Do two field sets carry the same message? */
export function mirrorFieldsEqual(a: MirrorFields, b: MirrorFields): boolean {
	return MIRROR_FIELD_NAMES.every((name) => mirrorFieldEqual(name, a, b));
}

/** True when a snapshot holds nothing at all: no envelope, no body, no reminder. */
export function isBlankMirrorFields(fields: MirrorFields): boolean {
	return (
		fields.toAddresses.length === 0 &&
		fields.ccAddresses.length === 0 &&
		fields.bccAddresses.length === 0 &&
		fields.subject.trim().length === 0 &&
		isBlankHtml(fields.bodyHtml) &&
		(fields.bodyBlocks === null || fields.bodyBlocks === '[]') &&
		fields.followUpRemindAt === null
	);
}

/**
 * Whether Restore must ask first: the row is not provably the one the copy was
 * taken against, so restoring could overwrite text saved since (G2). A copy
 * with no recorded row (legacy, or written before the row existed) always asks
 * when there is a row.
 */
export function restoreNeedsConfirmation(
	copy: { base: MirrorFields | null },
	row: MirrorFields | null
): boolean {
	if (row === null) return false;
	return copy.base === null || !mirrorFieldsEqual(copy.base, row);
}

/** Whether retention has expired a copy (client clock, same device). */
export function isMirrorCopyExpired(savedAt: number, now: number): boolean {
	return now - savedAt > MIRROR_RETENTION_MS;
}

/** The copy to offer: the newest one. Ties keep the first. */
export function pickNewest<T extends { savedAt: number }>(candidates: readonly T[]): T | null {
	let best: T | null = null;
	for (const candidate of candidates) {
		if (!best || candidate.savedAt > best.savedAt) best = candidate;
	}
	return best;
}

/** Structural equality of two stored values (IndexedDB hands back clones). */
export function sameStoredValue(a: unknown, b: unknown): boolean {
	return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const record = value as Record<string, unknown>;
	const entries = Object.keys(record)
		.sort()
		.filter((key) => record[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
	return `{${entries.join(',')}}`;
}
