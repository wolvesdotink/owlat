/**
 * Pure detection helpers for the `security_scan` Agent step. Moved here
 * from the deleted `convex/agent/agentSecurity.ts` so both the step
 * module and the `draft` step's defense-in-depth context scan can
 * import them without dragging in the action wrapper.
 */

/**
 * Confidence floor (0–1) at or above which a detected prompt-injection match is
 * treated as a real threat — quarantining inbound and blocking outbound. Single
 * source of truth so the inbound (`security_scan`, `route`) and outbound
 * (`draft` context re-scan) gates can't drift apart.
 */
export const INJECTION_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Longest input, in UTF-16 code units, that {@link stripHiddenContent} and
 * {@link detectSmuggling} look at; anything past it is dropped before scanning.
 * Inbound mail is sender-controlled, so the scan cost has to stay bounded. The
 * guard model reads at most a few windows of the stripped text and the draft
 * context is built from the same stripped text, so the cap never lets a model
 * read content the scan skipped.
 */
export const MAX_SCAN_INPUT_CHARS = 1_000_000;

const capScanInput = (input: string): string =>
	input.length > MAX_SCAN_INPUT_CHARS ? input.slice(0, MAX_SCAN_INPUT_CHARS) : input;

// ── Prompt Injection Patterns ──

export const INJECTION_PATTERNS = [
	// Direct injection
	/ignore\s+(all\s+)?previous\s+instructions/i,
	/ignore\s+(all\s+)?above\s+instructions/i,
	/disregard\s+(all\s+)?previous/i,
	/forget\s+(all\s+)?previous/i,
	/you\s+are\s+now\s+/i,
	/new\s+instructions?\s*:/i,
	/system\s+prompt\s*:/i,
	/\[system\]/i,
	/\[INST\]/i,
	// Delimiter attacks
	/<\|im_start\|>/i,
	/<\|im_end\|>/i,
	/```system/i,
	/---\s*system/i,
	/###\s*instructions?/i,
	// Role impersonation
	/as\s+(your|the)\s+(developer|admin|system|creator)/i,
	/i\s+am\s+(your|the)\s+(developer|admin|system|creator)/i,
	/from\s+the\s+system\s*:/i,
];

/**
 * Check for hidden instructions in HTML content.
 */
export function detectSmuggling(rawHtml?: string): {
	detected: boolean;
	type?: string;
	content?: string;
} {
	if (!rawHtml) return { detected: false };
	const htmlBody = capScanInput(rawHtml);

	// HTML comment instructions
	const comment = findInstructionComment(htmlBody);
	if (comment) {
		return {
			detected: true,
			type: 'html_comment',
			content: comment.slice(0, 200),
		};
	}

	// Invisible text (zero-font-size, display:none, zero-width)
	const invisiblePatterns = [
		/style\s*=\s*["'][^"']*font-size\s*:\s*0/i,
		/style\s*=\s*["'][^"']*display\s*:\s*none/i,
		/style\s*=\s*["'][^"']*visibility\s*:\s*hidden/i,
		// The colour arguments are length-bounded so an unterminated `rgba(` cannot
		// make the match rescan the rest of the attribute from every `color:`.
		/style\s*=\s*["'][^"']*color\s*:\s*(?:white|#fff(?:fff)?|rgba?\([^)]{0,64},\s*0\s*\))/i,
	];

	for (const pattern of invisiblePatterns) {
		const match = htmlBody.match(pattern);
		if (match) {
			const surroundingText = htmlBody.slice(
				Math.max(0, (match.index ?? 0) - 50),
				(match.index ?? 0) + (match[0]?.length ?? 0) + 200
			);
			if (INJECTION_PATTERNS.some((p) => p.test(surroundingText))) {
				return {
					detected: true,
					type: 'invisible_text',
					content: surroundingText.slice(0, 200),
				};
			}
		}
	}

	// Zero-width characters hiding instructions.
	// Use alternation rather than a character class because ZWJ/ZWNJ can form
	// misleading combining sequences inside a character class (oxlint: no-misleading-character-class).
	const zeroWidthPattern = /(?:​|‌|‍|﻿|⁠){3,}/u;
	if (zeroWidthPattern.test(htmlBody)) {
		return {
			detected: true,
			type: 'zero_width_chars',
			content: 'Multiple zero-width characters detected',
		};
	}

	return { detected: false };
}

/**
 * First HTML comment whose body starts with an instruction keyword, or null.
 * The same match as `<!--\s*(ignore|system|...)[\s\S]*?-->`, done as one forward
 * pass: when the first opener has no `-->` after it, no later opener can close
 * either.
 */
function findInstructionComment(html: string): string | null {
	const opener = /<!--\s*(?:ignore|system|instructions?|prompt|override)/i.exec(html);
	if (!opener) return null;
	const close = html.indexOf('-->', opener.index + opener[0].length);
	return close === -1 ? null : html.slice(opener.index, close + 3);
}

/**
 * Replace every `open ... close` span (first `close` after each `open`) with a
 * single space, left to right. Linear: each search starts where the previous one
 * ended, and an `open` without a following `close` ends the pass, because no
 * later `open` could be closed either. Both regexes must carry the `g` flag.
 */
function stripDelimited(input: string, open: RegExp, close: RegExp): string {
	let out = '';
	let pos = 0;
	for (;;) {
		open.lastIndex = pos;
		const start = open.exec(input);
		if (!start) break;
		close.lastIndex = start.index + start[0].length;
		const end = close.exec(input);
		if (!end) break;
		out += `${input.slice(pos, start.index)} `;
		pos = end.index + end[0].length;
	}
	return pos === 0 ? input : out + input.slice(pos);
}

/**
 * An inline style that hides its element: display:none, visibility:hidden,
 * font-size:0, opacity:0, or white / fully transparent text. The negative
 * lookbehind keeps `background-color: white` visible. The `rgba(` arguments
 * are length-bounded so a long unterminated value cannot backtrack.
 */
const HIDING_STYLE =
	/display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?(?![.\d])|opacity\s*:\s*0(?:\.0+)?(?![.\d])|(?<![-\w])color\s*:\s*(?:white|#fff(?:fff)?|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)|rgba\([^)]{0,64},\s*0(?:\.0+)?\s*\))/i;
const isTagSpace = (c: string | undefined): boolean =>
	c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * Read the attributes of an opening tag the way an HTML tokenizer does, from
 * just after the tag name. Returns the index of the tag's closing `>` and the
 * value of its first `style` attribute, or null when the tag never ends (no
 * `>`, or a quoted value whose quote never closes). A `>` inside a quoted value
 * does not end the tag, and a quote only opens a value right after `=`, as in
 * the browser. Each character is looked at once.
 */
function readOpenTag(input: string, from: number): { end: number; style: string | null } | null {
	let style: string | null = null;
	let i = from;
	for (;;) {
		while (i < input.length && (isTagSpace(input[i]) || input[i] === '/')) i++;
		if (i >= input.length) return null;
		if (input[i] === '>') return { end: i, style };

		// Attribute name: a leading `=` belongs to the name.
		const nameStart = i;
		i++;
		while (i < input.length) {
			const c = input[i];
			if (isTagSpace(c) || c === '/' || c === '>' || c === '=') break;
			i++;
		}
		const name = input.slice(nameStart, i);
		while (i < input.length && isTagSpace(input[i])) i++;
		if (input[i] !== '=') continue;
		i++;
		while (i < input.length && isTagSpace(input[i])) i++;

		let value: string;
		const quote = input[i];
		if (quote === '"' || quote === "'") {
			const close = input.indexOf(quote, i + 1);
			if (close === -1) return null;
			value = input.slice(i + 1, close);
			i = close + 1;
		} else {
			const valueStart = i;
			while (i < input.length && !isTagSpace(input[i]) && input[i] !== '>') i++;
			value = input.slice(valueStart, i);
		}
		if (style === null && name.toLowerCase() === 'style') style = value;
	}
}

/**
 * Drop every element whose inline style hides it: the opening tag, its content
 * and the first matching closing tag (tag names compared case-insensitively,
 * no nesting). One forward pass:
 *   - closing tags are indexed up front, per tag name, in document order, and
 *     each name's cursor only moves forward;
 *   - an opening tag is read attribute by attribute up to its closing `>`, and
 *     scanning resumes after it (or after the dropped element), so no character
 *     is looked at twice by the tag search. A tag that never ends (no `>`, or a
 *     quoted value that never closes) ends the pass, because no later tag could
 *     end either.
 * A visible styled element is kept and its content still scanned, so a hidden
 * element nested inside it is removed too.
 */
function stripHiddenElements(input: string): string {
	const closings = new Map<string, { starts: number[]; ends: number[]; next: number }>();
	const closeTag = /<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/g;
	for (let m = closeTag.exec(input); m; m = closeTag.exec(input)) {
		const name = (m[1] as string).toLowerCase();
		let entry = closings.get(name);
		if (!entry) {
			entry = { starts: [], ends: [], next: 0 };
			closings.set(name, entry);
		}
		entry.starts.push(m.index);
		entry.ends.push(m.index + m[0].length);
	}
	if (closings.size === 0) return input;

	const openTag = /<([a-zA-Z][a-zA-Z0-9]*)\b/g;
	let out = '';
	let copied = 0;
	let pos = 0;
	for (;;) {
		openTag.lastIndex = pos;
		const open = openTag.exec(input);
		if (!open) break;
		const tag = readOpenTag(input, open.index + open[0].length);
		if (!tag) break;
		pos = tag.end + 1;

		if (tag.style === null || !HIDING_STYLE.test(tag.style)) continue;

		const entry = closings.get((open[1] as string).toLowerCase());
		if (!entry) continue;
		while (entry.next < entry.starts.length && (entry.starts[entry.next] as number) < pos) {
			entry.next++;
		}
		if (entry.next >= entry.starts.length) continue;

		out += `${input.slice(copied, open.index)} `;
		copied = entry.ends[entry.next] as number;
		entry.next++;
		pos = copied;
	}
	return copied === 0 ? input : out + input.slice(copied);
}

/**
 * STRIP (not just DETECT) content that is hidden from a human reader but still
 * legible to an LLM, so a smuggled instruction can never reach a model. This is
 * the strip complement to {@link detectSmuggling}: detection flags a message for
 * quarantine; stripping neutralizes whatever hidden text survives INTO the paths
 * a model actually reads (the guard sample and the assembled draft context).
 * Defense in depth: a message that scored below the quarantine threshold must
 * still never feed hidden instructions to a model.
 *
 * Pure + deterministic. Strips, in order:
 *   - HTML comments (`<!-- ... -->`) -- a classic instruction-smuggling channel.
 *   - `<script>` / `<style>` elements (never human-visible prose).
 *   - Elements whose inline style hides them: display:none, visibility:hidden,
 *     font-size:0, opacity:0, or white / near-white text (white-on-white). A
 *     negative lookbehind keeps `background-color: white` (visible dark text on
 *     a white background) from being treated as hidden.
 *   - Zero-width / invisible / bidi-control unicode used to obfuscate payloads.
 *
 * Non-HTML plain text is handled too: the element rules simply don't match, but
 * the comment strip and the zero-width strip still apply. Input past
 * {@link MAX_SCAN_INPUT_CHARS} is dropped first, and every pass is a single
 * forward scan, so the cost stays linear in the input. Never throws.
 */
export function stripHiddenContent(input: string | undefined | null): string {
	if (!input) return '';
	let out = capScanInput(input);

	// 1. HTML comments (first `-->` after each `<!--`).
	out = stripDelimited(out, /<!--/g, /-->/g);

	// 2. <script> / <style> blocks -- content is never human-visible prose.
	out = stripDelimited(out, /<script/gi, /<\/script>/gi);
	out = stripDelimited(out, /<style/gi, /<\/style>/gi);

	// 3. Elements hidden via inline style: the opening tag, its content and the
	//    matching closing tag go. Non-nesting -- good enough that a smuggled
	//    `<span style="display:none">...</span>` payload is removed; a hidden
	//    element that slips through is still DETECTED upstream and quarantined
	//    by detectSmuggling.
	out = stripHiddenElements(out);

	// 4. Zero-width / invisible / bidi-control characters. The zero-width
	//    joiner/non-joiner (U+200C/U+200D) are listed as standalone alternatives
	//    rather than inside a character class -- a class containing them can form
	//    misleading combining sequences (oxlint: no-misleading-character-class),
	//    the same reason detectSmuggling's zero-width probe uses alternation.
	out = out.replace(/­|​|‌|‍|‎|‏|[‪-‮]|[⁠-⁤]|﻿/g, '');

	return out;
}

/**
 * Run pattern-based prompt injection detection on text content.
 */
export function detectInjection(text: string): {
	detected: boolean;
	pattern?: string;
	confidence: number;
} {
	for (const pattern of INJECTION_PATTERNS) {
		if (pattern.test(text)) {
			return {
				detected: true,
				pattern: pattern.source,
				confidence: 0.85,
			};
		}
	}
	return { detected: false, confidence: 0 };
}

/**
 * Basic spam score heuristic (0-100).
 */
export function calculateSpamScore(text: string, subject: string): number {
	let score = 0;
	const combined = `${subject} ${text}`.toLowerCase();

	// ALL CAPS subject
	if (subject === subject.toUpperCase() && subject.length > 5) score += 15;

	// Excessive exclamation marks
	const exclamations = (combined.match(/!/g) ?? []).length;
	if (exclamations > 3) score += 10;

	// Common spam keywords
	const spamKeywords = [
		'act now',
		'limited time',
		'urgent',
		'congratulations',
		'you have won',
		'click here',
		'unsubscribe',
		'buy now',
		'free',
		'winner',
		'prize',
		'million dollars',
		'nigerian prince',
		'wire transfer',
	];
	for (const kw of spamKeywords) {
		if (combined.includes(kw)) score += 10;
	}

	// Excessive links
	const linkCount = (text.match(/https?:\/\//g) ?? []).length;
	if (linkCount > 10) score += 15;

	return Math.min(score, 100);
}
