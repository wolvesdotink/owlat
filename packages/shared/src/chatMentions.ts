/**
 * The chat `@handle` grammar, defined once.
 *
 * Three places read it and must agree: the Convex send path decides who gets
 * notified (`apps/api/convex/chat/_helpers.ts`), the message renderer
 * highlights mentions (`ChatMessage.vue`) and the composer decides when the
 * mention picker is open (`ChatInput.vue`). Pure and framework-free (it
 * imports nothing) so both sides can share it.
 *
 * Every helper builds a fresh RegExp per call: a module-level `/g` regex keeps
 * `lastIndex` between calls and would skip matches.
 */

/** Characters a mention handle may contain. */
const HANDLE_CHARS = 'a-zA-Z0-9_\\-.';
/** Longest handle the server resolves; a longer run is not a mention. */
const HANDLE_MAX = 64;

const mentionPattern = (): RegExp => new RegExp(`@([${HANDLE_CHARS}]{1,${HANDLE_MAX}})`, 'g');

/**
 * Unique `@handle` mentions in `text`, lowercased and without the leading `@`.
 * Resolving them to member ids happens in the api's `resolveMentionsToMemberIds`.
 */
export function parseMentionHandles(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(mentionPattern())) {
		const handle = match[1];
		if (handle) found.add(handle.toLowerCase());
	}
	return [...found];
}

/**
 * Split `text` into plain runs and `@handle` mentions, in order, so a renderer
 * can emphasise the mentions. A mention segment keeps its leading `@`.
 */
export function splitMentionSegments(text: string): { kind: 'text' | 'mention'; value: string }[] {
	const parts: { kind: 'text' | 'mention'; value: string }[] = [];
	let cursor = 0;
	for (const match of text.matchAll(mentionPattern())) {
		if (match.index > cursor) {
			parts.push({ kind: 'text', value: text.slice(cursor, match.index) });
		}
		parts.push({ kind: 'mention', value: match[0] });
		cursor = match.index + match[0].length;
	}
	if (cursor < text.length) {
		parts.push({ kind: 'text', value: text.slice(cursor) });
	}
	return parts;
}

/**
 * Whether `fragment` (the text typed after an `@`, possibly empty) can still
 * become a handle. The composer keeps the mention picker open only while this
 * holds, so a fragment past the length cap closes it, matching who the server
 * would actually notify.
 */
export function isMentionHandlePrefix(fragment: string): boolean {
	return new RegExp(`^[${HANDLE_CHARS}]{0,${HANDLE_MAX}}$`).test(fragment);
}
