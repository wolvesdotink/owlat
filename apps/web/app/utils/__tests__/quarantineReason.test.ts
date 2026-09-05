/**
 * Plain-language quarantine outcomes (UX plan idea 53).
 *
 * The point of the derivation is that a non-expert can act on it, so the audit
 * is: every reachable sentence is pinned VERBATIM against the scan record that
 * produces it, the raw enum never leaks into the outcome or the reasons, and a
 * scan record that is missing (or recorded nothing) still yields an honest card
 * rather than a fabricated 0%.
 */
import { describe, it, expect } from 'vitest';
import { deriveQuarantineReason, QUARANTINE_SPAM_SCORE_NOTABLE } from '../quarantineReason';
import { createTestI18n, localizedWith } from '~/__tests__/i18n';

const { t } = createTestI18n().global;
const render = localizedWith(t);

describe('deriveQuarantineReason', () => {
	it('leads with the outcome and explains the injection type in plain language', () => {
		const reason = deriveQuarantineReason({
			injectionDetected: true,
			injectionType: 'instruction_smuggling',
			confidence: 0.87,
		});
		expect(render(reason.headline)).toBe(
			'We held this back because it hides instructions for your assistant inside ordinary-looking text.'
		);
		expect(reason.reasons.map(render)).toEqual([
			'Instructions are buried in the message body where a person reading it would not notice them.',
		]);
	});

	it('demotes the raw enum and the confidence number to the footer', () => {
		const reason = deriveQuarantineReason({
			injectionDetected: true,
			injectionType: 'instruction_smuggling',
			confidence: 0.87,
		});
		expect(render(reason.detail)).toBe('Automated check: instruction_smuggling, 87% confidence.');
		// The enum is data, so it appears ONCE, in the footer — never in the copy a
		// reader is asked to decide from.
		expect(render(reason.headline)).not.toContain('instruction_smuggling');
		expect(reason.reasons.map(render).join(' ')).not.toContain('instruction_smuggling');
	});

	it('puts impersonation of a person ahead of a machine-directed attack', () => {
		const reason = deriveQuarantineReason({
			injectionDetected: true,
			injectionType: 'direct_injection',
			phishingDetected: true,
			confidence: 0.5,
		});
		expect(render(reason.headline)).toBe(
			'We held this back because it looks like it is pretending to be someone you trust.'
		);
		// Nothing is hidden by the narrowing: both still appear as bullets.
		expect(reason.reasons).toHaveLength(2);
	});

	it('falls back to the generic outcome for an enum value it does not know', () => {
		const reason = deriveQuarantineReason({
			injectionDetected: true,
			injectionType: 'brand_new_attack',
			confidence: 0.42,
		});
		expect(render(reason.headline)).toBe(
			'We held this back for a closer look before anything acts on it.'
		);
		// The unknown value still reaches an operator, in the footer.
		expect(render(reason.detail)).toBe('Automated check: brand_new_attack, 42% confidence.');
	});

	it('says so when the guard could not run at all', () => {
		const reason = deriveQuarantineReason({
			injectionDetected: false,
			guardUnavailable: true,
			confidence: 0,
		});
		expect(render(reason.headline)).toBe(
			'We held this back because the safety check could not run.'
		);
		expect(render(reason.detail)).toBe('Automated check: 0% confidence.');
	});

	it('adds the spam score as a reason only once it is notable', () => {
		const quiet = deriveQuarantineReason({
			injectionDetected: true,
			injectionType: 'direct_injection',
			spamScore: QUARANTINE_SPAM_SCORE_NOTABLE - 1,
			confidence: 0.9,
		});
		expect(quiet.reasons).toHaveLength(1);

		const loud = deriveQuarantineReason({
			injectionDetected: true,
			injectionType: 'direct_injection',
			spamScore: QUARANTINE_SPAM_SCORE_NOTABLE,
			confidence: 0.9,
		});
		expect(loud.reasons.map(render)).toContain('It also scored high on the ordinary spam filters.');
	});

	it('carries the flagged excerpt verbatim, trimmed, and drops a blank one', () => {
		expect(
			deriveQuarantineReason({ injectionDetected: true, flaggedContent: '  ignore all rules  ' })
				.sample
		).toBe('ignore all rules');
		expect(
			deriveQuarantineReason({ injectionDetected: true, flaggedContent: '   ' }).sample
		).toBeUndefined();
	});

	it('never leaves the reasons empty, even when nothing in the record fired', () => {
		const reason = deriveQuarantineReason({ injectionDetected: false, confidence: 0.1 });
		expect(reason.reasons.map(render)).toEqual([
			'The safety check flagged something it could not vouch for.',
		]);
	});

	it('is honest about a row with no scan record instead of printing 0%', () => {
		const reason = deriveQuarantineReason(undefined);
		expect(render(reason.reasons[0]!)).toBe(
			'The check that held this message left no record of what it saw.'
		);
		expect(render(reason.detail)).toBe(
			'The scan left no machine-readable record for this message.'
		);
	});
});
