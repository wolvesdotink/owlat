/**
 * Subject Line Analysis
 *
 * Detects ALL-CAPS abuse and excessive punctuation in email subject lines.
 * Migrated from apps/api/convex/lib/contentScanner.ts
 */

import type { ContentFlag } from '../types.js';
import { registerContentRule } from './rule.js';

/**
 * Check for ALL-CAPS abuse in subject line.
 */
export function scanCapsAbuse(subject: string): ContentFlag[] {
	const flags: ContentFlag[] = [];

	if (subject.length >= 10) {
		const letters = subject.replace(/[^a-zA-Z]/g, '');
		const upperCase = letters.replace(/[^A-Z]/g, '');

		if (letters.length > 0 && upperCase.length / letters.length > 0.5) {
			flags.push({
				type: 'caps_abuse',
				severity: 'low',
				description: 'Subject line is mostly ALL CAPS — this triggers spam filters',
				match: subject,
			});
		}
	}

	return flags;
}

/**
 * Check for excessive punctuation (!!!!! or ????).
 */
export function scanExcessivePunctuation(subject: string): ContentFlag[] {
	const flags: ContentFlag[] = [];

	const exclamationCount = (subject.match(/!/g) || []).length;
	const questionCount = (subject.match(/\?/g) || []).length;

	if (exclamationCount >= 3 || questionCount >= 3) {
		flags.push({
			type: 'excessive_punctuation',
			severity: 'low',
			description: `Excessive punctuation in subject line (${exclamationCount} exclamation marks, ${questionCount} question marks)`,
			match: subject,
		});
	}

	return flags;
}

registerContentRule({
	id: 'caps-abuse',
	scan: ({ subject }) => scanCapsAbuse(subject),
});

registerContentRule({
	id: 'excessive-punctuation',
	scan: ({ subject }) => scanExcessivePunctuation(subject),
});
