/**
 * Prohibited Content Scanner
 *
 * Detects prohibited content patterns like advance fee fraud, credential phishing,
 * and requests for sensitive personal information.
 * Migrated from apps/api/convex/lib/contentScanner.ts
 */

import type { ContentFlag } from '../types.js';
import { registerContentRule } from './rule.js';

const PROHIBITED_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
	{ pattern: /\b(nigerian? prince|advance[d]? fee|419 scam)\b/i, description: 'Advance fee fraud pattern detected' },
	{ pattern: /\b(wire transfer|western union|moneygram)\s+(immediately|urgently|today)\b/i, description: 'Urgent wire transfer request detected' },
	{ pattern: /\b(social security|ssn|credit card)\s*(number|#|no\.?)\b/i, description: 'Request for sensitive personal information detected' },
	{ pattern: /\b(password|login|credential)s?\s+(confirm|verify|update|reset)\b/i, description: 'Credential phishing pattern detected' },
	{ pattern: /\b(confirm|verify|update|reset)\s+(your\s+)?(password|login|credential)s?\b/i, description: 'Credential phishing pattern detected' },
	{ pattern: /\bprovide\s+(your\s+)?(social security|ssn|credit card)\b/i, description: 'Request for sensitive personal information detected' },
];

/**
 * Scan for prohibited content patterns.
 */
export function scanProhibitedContent(text: string): ContentFlag[] {
	const flags: ContentFlag[] = [];

	for (const { pattern, description } of PROHIBITED_PATTERNS) {
		if (pattern.test(text)) {
			flags.push({
				type: 'prohibited_content',
				severity: 'high',
				description,
			});
		}
	}

	return flags;
}

registerContentRule({
	id: 'prohibited-content',
	scan: ({ text }) => scanProhibitedContent(text),
});
