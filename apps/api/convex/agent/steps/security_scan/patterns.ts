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
export function detectSmuggling(htmlBody?: string): {
	detected: boolean;
	type?: string;
	content?: string;
} {
	if (!htmlBody) return { detected: false };

	// HTML comment instructions
	const commentMatch = htmlBody.match(
		/<!--\s*(ignore|system|instructions?|prompt|override)[\s\S]*?-->/i,
	);
	if (commentMatch) {
		return {
			detected: true,
			type: 'html_comment',
			content: commentMatch[0].slice(0, 200),
		};
	}

	// Invisible text (zero-font-size, display:none, zero-width)
	const invisiblePatterns = [
		/style\s*=\s*["'][^"']*font-size\s*:\s*0/i,
		/style\s*=\s*["'][^"']*display\s*:\s*none/i,
		/style\s*=\s*["'][^"']*visibility\s*:\s*hidden/i,
		/style\s*=\s*["'][^"']*color\s*:\s*(?:white|#fff(?:fff)?|rgba?\([^)]*,\s*0\s*\))/i,
	];

	for (const pattern of invisiblePatterns) {
		const match = htmlBody.match(pattern);
		if (match) {
			const surroundingText = htmlBody.slice(
				Math.max(0, (match.index ?? 0) - 50),
				(match.index ?? 0) + (match[0]?.length ?? 0) + 200,
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
 * the comment strip and the zero-width strip still apply. Never throws.
 */
export function stripHiddenContent(input: string | undefined | null): string {
	if (!input) return '';
	let out = input;

	// 1. HTML comments (per-comment, non-greedy).
	out = out.replace(/<!--[\s\S]*?-->/g, ' ');

	// 2. <script> / <style> blocks -- content is never human-visible prose.
	out = out.replace(/<script[\s\S]*?<\/script>/gi, ' ');
	out = out.replace(/<style[\s\S]*?<\/style>/gi, ' ');

	// 3. Elements hidden via inline style. Match an opening tag whose `style`
	//    attribute contains a hiding rule and drop the element (open tag + inner
	//    content + matching close tag). Bounded, non-nesting -- good enough that
	//    a smuggled `<span style="display:none">...</span>` payload is removed; a
	//    hidden element that slips through is still DETECTED upstream and
	//    quarantined by detectSmuggling.
	const hidingStyle =
		/display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?(?![.\d])|opacity\s*:\s*0(?:\.0+)?(?![.\d])|(?<![-\w])color\s*:\s*(?:white|#fff(?:fff)?|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)|rgba\([^)]*,\s*0(?:\.0+)?\s*\))/i;
	const tagWithStyle =
		/<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bstyle\s*=\s*("[^"]*"|'[^']*')[^>]*>([\s\S]*?)<\/\1\s*>/g;
	out = out.replace(tagWithStyle, (full, _tag, styleAttr: string) =>
		hidingStyle.test(styleAttr) ? ' ' : full,
	);

	// 4. Zero-width / invisible / bidi-control characters. The zero-width
	//    joiner/non-joiner (U+200C/U+200D) are listed as standalone alternatives
	//    rather than inside a character class -- a class containing them can form
	//    misleading combining sequences (oxlint: no-misleading-character-class),
	//    the same reason detectSmuggling's zero-width probe uses alternation.
	out = out.replace(
		/­|​|‌|‍|‎|‏|[‪-‮]|[⁠-⁤]|﻿/g,
		'',
	);

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
		'act now', 'limited time', 'urgent', 'congratulations', 'you have won',
		'click here', 'unsubscribe', 'buy now', 'free', 'winner', 'prize',
		'million dollars', 'nigerian prince', 'wire transfer',
	];
	for (const kw of spamKeywords) {
		if (combined.includes(kw)) score += 10;
	}

	// Excessive links
	const linkCount = (text.match(/https?:\/\//g) ?? []).length;
	if (linkCount > 10) score += 15;

	return Math.min(score, 100);
}
