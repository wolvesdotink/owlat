/**
 * Shared RFC 6376 §3.2 `tag=value` list parser.
 *
 * Both the DKIM-Signature header (mail-auth `dkim/messageSignature.ts`, and the
 * ARC headers in `arc/chain.ts`) and the `_domainkey` TXT key record (mail-auth
 * `dkim/keyRecord.ts`) are `tag=value` lists split on `;`, differing only in
 * how the VALUE is normalized (a signature tag is merely trimmed; a key-record
 * value has all internal whitespace removed because base64 / colon lists are
 * folded across TXT chunks) and whether tag NAMES are lowercased. This is the
 * single implementation both consume so the parse rules never drift apart.
 * The Convex backend's DNS verifier (`domains/dnsMatch.ts`) and deliverability
 * checklist (`delivery/checklistDkimValidation.ts`) parse the records we
 * publish with the same grammar, so a key record gets one verdict everywhere.
 *
 * FIRST-WINS on duplicate tag names: RFC 6376 §3.2 says a duplicate tag name
 * makes the whole list invalid. mailauth does not reject on it either, but it is
 * LAST-wins (a later duplicate `d=`/`p=` overrides the earlier one). We instead
 * take the more conservative FIRST-wins reading, so a later duplicate can never
 * override an earlier tag — a DELIBERATE divergence from mailauth's last-wins,
 * chosen because letting a trailing duplicate silently redirect a key lookup or
 * signing domain is the more dangerous hostile-input behavior. Pinned by
 * fixtures in the differential and key-record suites. Callers that need the
 * RFC's reject-the-list reading use {@link parseStrictTagList}.
 *
 * Pure: no DNS, no Node built-ins, safe in the Convex V8 runtime.
 */

/** Options controlling how a tag list is normalized. */
export interface TagListOptions {
	/** Normalize a raw value (everything after the first `=` in a segment). */
	readonly normalizeValue: (raw: string) => string;
	/** Lowercase tag names before storing (key records are case-insensitive). */
	readonly lowercaseName: boolean;
}

/**
 * Remove ALL whitespace from a tag value — for key-record style values (base64
 * `p=`, colon lists `h=`/`s=`/`t=`, DMARC URI lists) that a DNS panel may fold
 * across TXT chunks or wrap at a column, and that never carry significant WSP.
 */
export function stripTagValueWhitespace(raw: string): string {
	return raw.replace(/[ \t\r\n]+/g, '');
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

/** RFC 6376 §3.2 `tag-name = ALPHA *ALNUMPUNC` (ALNUMPUNC is ALPHA / DIGIT / `_`). */
const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The RFC 6376 §3.2 reading of a tag list: returns `null` — the whole list is
 * invalid — on a duplicate tag name, a name that is empty or not a valid
 * `tag-name`, or a segment without `=`. A single trailing `;` (optionally
 * followed by whitespace) is allowed; any other empty segment is invalid.
 * Insertion order is the record's order, so callers can check which tag came
 * first. Names are compared after `options.lowercaseName`.
 */
export function parseStrictTagList(
	input: string,
	options: TagListOptions
): Map<string, string> | null {
	const segments = input.split(';');
	if (segments.length > 1 && segments[segments.length - 1]!.trim() === '') segments.pop();
	const tags = new Map<string, string>();
	for (const segment of segments) {
		const eq = segment.indexOf('=');
		if (eq === -1) return null;
		const rawName = segment.slice(0, eq).trim();
		if (!TAG_NAME_RE.test(rawName)) return null;
		const name = options.lowercaseName ? rawName.toLowerCase() : rawName;
		if (tags.has(name)) return null;
		tags.set(name, options.normalizeValue(segment.slice(eq + 1)));
	}
	return tags;
}
