/**
 * Shared RFC 6376 §3.2 `tag=value` list parser.
 *
 * Both the DKIM-Signature header (`verify.ts`) and the `_domainkey` TXT key
 * record (`keyRecord.ts`) are `tag=value` lists split on `;`, differing only in
 * how the VALUE is normalized (a signature tag is merely trimmed; a key-record
 * value has all internal whitespace removed because base64 / colon lists are
 * folded across TXT chunks) and whether tag NAMES are lowercased. This is the
 * single implementation both consume so the parse rules never drift apart.
 *
 * FIRST-WINS on duplicate tag names: RFC 6376 §3.2 says a duplicate tag name
 * makes the whole list invalid. mailauth does not reject on it either, but it is
 * LAST-wins (a later duplicate `d=`/`p=` overrides the earlier one). We instead
 * take the more conservative FIRST-wins reading, so a later duplicate can never
 * override an earlier tag — a DELIBERATE divergence from mailauth's last-wins,
 * chosen because letting a trailing duplicate silently redirect a key lookup or
 * signing domain is the more dangerous hostile-input behavior. Pinned by
 * fixtures in the differential and key-record suites.
 */

/** Options controlling how a tag list is normalized. */
export interface TagListOptions {
	/** Normalize a raw value (everything after the first `=` in a segment). */
	readonly normalizeValue: (raw: string) => string;
	/** Lowercase tag names before storing (key records are case-insensitive). */
	readonly lowercaseName: boolean;
}

/**
 * Parse `input` (the tag-list body, WITHOUT any leading `field-name:`) into a
 * first-wins `Map` of tag name -> normalized value. Segments without a `=` or
 * with an empty name are ignored. Never throws.
 */
export function parseTagList(input: string, options: TagListOptions): Map<string, string> {
	const tags = new Map<string, string>();
	for (const segment of input.split(';')) {
		const eq = segment.indexOf('=');
		if (eq === -1) {
			continue;
		}
		const rawName = segment.slice(0, eq).trim();
		const name = options.lowercaseName ? rawName.toLowerCase() : rawName;
		if (name === '') {
			continue;
		}
		if (!tags.has(name)) {
			tags.set(name, options.normalizeValue(segment.slice(eq + 1)));
		}
	}
	return tags;
}
