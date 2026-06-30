/**
 * Spam Keyword Scanner
 *
 * Detects spam keywords and patterns in email content with weighted scoring.
 * Migrated from apps/api/convex/lib/contentScanner.ts
 */

import type { ContentFlag } from '../types.js';
import { registerContentRule } from './rule.js';

/** Keywords with associated spam scores. Higher = more spammy. */
const SPAM_KEYWORDS: Array<{ pattern: RegExp; score: number; label: string }> = [
	// Financial scams
	{ pattern: /\bfree money\b/i, score: 5, label: 'free money' },
	{ pattern: /\bmake money fast\b/i, score: 5, label: 'make money fast' },
	{ pattern: /\bdouble your (money|income|investment)\b/i, score: 5, label: 'double your money' },
	{ pattern: /\bget rich quick\b/i, score: 5, label: 'get rich quick' },
	{ pattern: /\b(million|billion) dollars?\b/i, score: 3, label: 'large money claim' },
	{ pattern: /\bfinancial freedom\b/i, score: 2, label: 'financial freedom' },
	{ pattern: /\bno investment (required|needed)\b/i, score: 4, label: 'no investment required' },
	{ pattern: /\bguaranteed (income|returns?|profit)\b/i, score: 4, label: 'guaranteed returns' },

	// Pharmaceutical spam
	{ pattern: /\bviagra\b/i, score: 5, label: 'viagra' },
	{ pattern: /\bcialis\b/i, score: 5, label: 'cialis' },
	{ pattern: /\bonline pharmacy\b/i, score: 4, label: 'online pharmacy' },
	{ pattern: /\bcheap (medications?|drugs?|pills?)\b/i, score: 4, label: 'cheap medications' },
	{ pattern: /\bweight loss (miracle|secret|pill)\b/i, score: 4, label: 'weight loss miracle' },

	// Urgency / pressure tactics
	{ pattern: /\bact now\b/i, score: 2, label: 'act now' },
	{ pattern: /\blimited time (only|offer)\b/i, score: 1, label: 'limited time' },
	{ pattern: /\burgent\b/i, score: 1, label: 'urgent' },
	{ pattern: /\bdon'?t miss (out|this)\b/i, score: 1, label: "don't miss out" },
	{ pattern: /\bexpires? (today|soon|immediately)\b/i, score: 2, label: 'expires soon' },
	{ pattern: /\byour account (will be|has been) (closed|suspended|terminated)\b/i, score: 5, label: 'account threat' },
	{ pattern: /\bimmediate action required\b/i, score: 3, label: 'immediate action required' },
	{ pattern: /\bverify your (account|identity|information)\b/i, score: 3, label: 'verify your account' },

	// Crypto/gambling scams
	{ pattern: /\bcrypto (trading|investment) (opportunity|secret)\b/i, score: 4, label: 'crypto scam' },
	{ pattern: /\binitial coin offering\b/i, score: 4, label: 'ICO' },
	{ pattern: /\bonline (casino|gambling|poker)\b/i, score: 4, label: 'online gambling' },
	{ pattern: /\bwin (big|cash|prizes?|jackpot)\b/i, score: 3, label: 'win prizes' },
	{ pattern: /\byou('ve| have) (been selected|won)\b/i, score: 4, label: 'you have won' },
	{ pattern: /\bcongratulations[!]* you('ve| have)? won\b/i, score: 5, label: 'congratulations you won' },

	// Adult content
	{ pattern: /\badult (content|dating|entertainment)\b/i, score: 4, label: 'adult content' },
	{ pattern: /\bxxx\b/i, score: 5, label: 'explicit content' },

	// Generic spam patterns
	{ pattern: /\bbuy now\b/i, score: 1, label: 'buy now' },
	{ pattern: /\bclick (here|below|now)\b/i, score: 1, label: 'click here' },
	{ pattern: /\b100% free\b/i, score: 2, label: '100% free' },
	{ pattern: /\bno (obligation|strings attached)\b/i, score: 2, label: 'no obligation' },
	{ pattern: /\bas seen on (tv|cnn|fox)\b/i, score: 3, label: 'as seen on TV' },
	{ pattern: /\bcall now\b/i, score: 2, label: 'call now' },
	{ pattern: /\bdear (friend|customer|user|member|sir|madam)\b/i, score: 2, label: 'generic greeting' },
];

/**
 * Scan text content for spam keywords.
 */
export function scanSpamKeywords(text: string, subject: string): ContentFlag[] {
	const flags: ContentFlag[] = [];
	let totalScore = 0;

	// Scan subject + body combined
	const combined = `${subject} ${text}`;

	for (const keyword of SPAM_KEYWORDS) {
		if (keyword.pattern.test(combined)) {
			totalScore += keyword.score;
			if (keyword.score >= 3) {
				flags.push({
					type: 'spam_keywords',
					severity: keyword.score >= 5 ? 'high' : 'medium',
					description: `Spam keyword detected: "${keyword.label}"`,
					match: keyword.label,
				});
			}
		}
	}

	// If total keyword score is high but individual keywords weren't flagged
	if (totalScore >= 8 && flags.length === 0) {
		flags.push({
			type: 'spam_keywords',
			severity: 'medium',
			description: `Multiple low-severity spam patterns detected (combined score: ${totalScore})`,
		});
	}

	return flags;
}

registerContentRule({
	id: 'spam-keywords',
	scan: ({ subject, text }) => scanSpamKeywords(text, subject),
});
