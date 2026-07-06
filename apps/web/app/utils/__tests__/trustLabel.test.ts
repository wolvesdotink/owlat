/**
 * trustLabel — human trust language for agent-drafted replies.
 *
 * Covers:
 *   - level mapping boundaries (0.6 / 0.8) and the failed-self-check state;
 *   - every known flag theme in the copy table translating to plain language;
 *   - unknown flags falling back to the generic reason (never the raw string);
 *   - flags demoting a high score to "Worth a look";
 *   - reason dedup + the quiet power-user confidence detail.
 */
import { describe, it, expect } from 'vitest';

import {
	escalationTrustLabel,
	TRUST_FLAG_COPY,
	TRUST_GENERIC_REASON,
	TRUST_UNCHECKED_REASON,
	trustFlagReason,
	trustLabel,
} from '../trustLabel';

describe('trustLabel level boundaries', () => {
	it('maps a clean high score to Ready to send', () => {
		const t = trustLabel(0.8, []);
		expect(t.level).toBe('ready');
		expect(t.label).toBe('Ready to send');
		expect(t.variant).toBe('success');
		expect(t.reasons.length).toBeGreaterThan(0);
	});

	it('maps a mid score to Worth a look', () => {
		expect(trustLabel(0.6, []).level).toBe('look');
		expect(trustLabel(0.79, []).level).toBe('look');
		expect(trustLabel(0.7, []).label).toBe('Worth a look');
		expect(trustLabel(0.7, []).variant).toBe('warning');
	});

	it('maps a low score to Needs you', () => {
		const t = trustLabel(0.59, []);
		expect(t.level).toBe('needs-you');
		expect(t.label).toBe('Needs you');
		expect(t.variant).toBe('error');
		expect(t.reasons.length).toBeGreaterThan(0);
	});

	it('maps a failed self-check (null/undefined confidence) to Needs you with the unchecked reason', () => {
		for (const c of [null, undefined]) {
			const t = trustLabel(c, []);
			expect(t.level).toBe('needs-you');
			expect(t.reasons[0]).toBe(TRUST_UNCHECKED_REASON);
			expect(t.detail).toBe('Agent confidence unavailable');
		}
	});

	it('demotes a high score to Worth a look when a flag tripped', () => {
		const t = trustLabel(0.9, ['tone is too harsh']);
		expect(t.level).toBe('look');
		expect(t.reasons).toContain('Tone reads harsher than your usual replies');
	});
});

describe('trustFlagReason copy table', () => {
	const CASES: Array<[flag: string, reason: string]> = [
		['mentions a price that was not confirmed', "Mentions a price or number I couldn't verify"],
		['invented a delivery detail', "States something I couldn't trace back to the conversation"],
		[
			'claim is not grounded in the thread',
			"States something I couldn't trace back to the conversation",
		],
		['promises a follow-up call', 'Makes a commitment on your behalf'],
		['cites a return policy', 'References a policy or terms worth double-checking'],
		['states a deadline the sender never gave', 'Mentions a date or time worth confirming'],
		['tone is abrupt and cold', 'Tone reads harsher than your usual replies'],
		['does not address the second question', 'May not answer everything they asked'],
		['vague about next steps', 'Part of the reply is vague and could be misread'],
		['wrong recipient name in the greeting', 'Double-check names and who the reply addresses'],
		[
			'refers to an attachment that is not included',
			'Mentions an attachment or link that may be missing',
		],
	];

	it.each(CASES)('translates %j', (flag, reason) => {
		expect(trustFlagReason(flag)).toBe(reason);
	});

	it('covers every copy-table entry with at least one case above', () => {
		const covered = new Set(CASES.map(([, reason]) => reason));
		for (const entry of TRUST_FLAG_COPY) {
			expect(covered.has(entry.reason)).toBe(true);
		}
	});

	it('falls back to the generic reason on an unknown flag — never the raw string', () => {
		const raw = 'zzz_quux_enum_value';
		const t = trustLabel(0.9, [raw]);
		expect(trustFlagReason(raw)).toBe(TRUST_GENERIC_REASON);
		expect(t.reasons).toContain(TRUST_GENERIC_REASON);
		expect(t.reasons.join(' ')).not.toContain(raw);
	});

	it('dedupes flags translating to the same reason and skips blank flags', () => {
		const t = trustLabel(0.5, ['tone too harsh', 'reads rude and curt', '   ']);
		expect(t.reasons).toEqual(['Tone reads harsher than your usual replies']);
	});
});

describe('detail line', () => {
	it('keeps the numeric confidence available as quiet detail', () => {
		expect(trustLabel(0.62, []).detail).toBe('Agent confidence 62%');
		expect(trustLabel(1, []).detail).toBe('Agent confidence 100%');
	});
});

describe('escalationTrustLabel', () => {
	it('always Needs you, with a human reason and no numeric confidence', () => {
		const t = escalationTrustLabel();
		expect(t.level).toBe('needs-you');
		expect(t.label).toBe('Needs you');
		expect(t.variant).toBe('error');
		expect(t.reasons.length).toBeGreaterThan(0);
		expect(t.detail).toBe('No agent draft');
	});
});
