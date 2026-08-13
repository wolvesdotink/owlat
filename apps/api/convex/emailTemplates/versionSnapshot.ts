/**
 * Email template version history (pure half) — the fingerprint, dedupe and
 * retention rules for `emailTemplateVersions`.
 *
 * The editor's undo stack (`packages/email-builder` `useHistory` +
 * `utils/deltaHistory`) is session-scoped: it dies with the tab. This table is
 * the durable sibling — one snapshot per meaningful event (save / publish /
 * campaign send) of the exact same serialized shape the editor round-trips
 * (`{ blocks, name, subject }`, with `blocks` as the `EditorBlock[]` JSON
 * string already stored in `emailTemplates.content`), so a restore can be fed
 * straight back into the editor refs and become an ordinary undoable edit.
 *
 * Snapshots are stored WHOLE rather than as `deltaHistory` patch chains. The
 * retention cap evicts the oldest rows, and evicting the head of a patch chain
 * orphans every delta behind it — the exact hazard `useHistory`'s trim loop
 * works around by only ever cutting at a checkpoint. At 50 rows per template a
 * full copy is the cheaper correctness guarantee.
 *
 * Kept free of Convex imports so the rules are unit-testable on their own.
 */

/** How many snapshots a single template retains. Oldest are evicted first. */
export const VERSION_HISTORY_LIMIT = 50;

/**
 * Extra rows a single capture is willing to evict beyond the cap, so the prune
 * read stays bounded. Steady state removes one row per capture; the slack only
 * matters if the limit is ever lowered.
 */
export const VERSION_PRUNE_BATCH = 25;

/** What caused a snapshot to be taken. */
export type TemplateVersionTrigger = 'save' | 'publish' | 'send';

/** The template fields a snapshot preserves. */
export interface TemplateVersionSource {
	name: string;
	subject: string;
	/** `EditorBlock[]` JSON — the same string as `emailTemplates.content`. */
	content: string;
}

export interface TemplateVersionFingerprint {
	contentHash: string;
	contentBytes: number;
}

/** UTF-8 byte length, so the panel reports transfer size and not code units. */
export function snapshotByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

/** FNV-1a/32, seeded, as 8 hex digits. */
function fnv1a(value: string, seed: number): string {
	let hash = seed >>> 0;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/**
 * Fingerprint the snapshot-relevant fields. Two independently seeded FNV-1a
 * lanes plus the length: a collision here silently DROPS a version, so 32 bits
 * is not enough margin, and a cryptographic digest is unavailable synchronously
 * inside a mutation.
 */
export function fingerprintSnapshot(source: TemplateVersionSource): TemplateVersionFingerprint {
	// NUL separators so ('a', 'bc') and ('ab', 'c') cannot fingerprint alike.
	const key = `${source.name}\u0000${source.subject}\u0000${source.content}`;
	return {
		contentHash: `${fnv1a(key, 0x811c9dc5)}${fnv1a(key, 0x9e3779b9)}${key.length.toString(16)}`,
		contentBytes: snapshotByteLength(source.content),
	};
}

export interface TemplateVersionMarker {
	contentHash: string;
	trigger: TemplateVersionTrigger;
}

/**
 * Whether a capture is worth a row.
 *
 * Identical content under the SAME trigger is noise — an editor save with no
 * edits, a re-publish of untouched content. Identical content under a
 * DIFFERENT trigger is the record of a distinct event ("this exact content is
 * what went out to the campaign"), which is the point of the history, so it is
 * always kept.
 */
export function shouldCaptureVersion(
	latest: TemplateVersionMarker | null,
	next: TemplateVersionMarker
): boolean {
	if (!latest) return true;
	return latest.contentHash !== next.contentHash || latest.trigger !== next.trigger;
}

/**
 * The rows past the cap in a NEWEST-FIRST list — i.e. the oldest ones, which
 * retention evicts. Callers read at most
 * `VERSION_HISTORY_LIMIT + VERSION_PRUNE_BATCH` rows, so the result is bounded.
 */
export function selectVersionsToEvict<T>(
	newestFirst: readonly T[],
	limit = VERSION_HISTORY_LIMIT
): T[] {
	if (newestFirst.length <= limit) return [];
	return newestFirst.slice(limit);
}
