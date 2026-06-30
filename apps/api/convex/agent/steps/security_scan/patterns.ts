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
