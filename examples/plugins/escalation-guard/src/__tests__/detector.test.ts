import { describe, expect, it } from 'vitest';
import {
	detectEscalation,
	meetsLevel,
	summarizeVerdict,
	worstLevel,
	MAX_SCAN_LENGTH,
	MAX_SIGNALS,
} from '../detector';

describe('detectEscalation', () => {
	it('reports no escalation for ordinary mail', () => {
		const verdict = detectEscalation({
			subject: 'Question about invoicing',
			textBody: 'Could you confirm which plan we are on? Thanks!',
		});
		expect(verdict).toEqual({ level: 'none', signals: [] });
		expect(summarizeVerdict(verdict)).toBe('No escalation signals detected.');
	});

	it('escalates on a legal threat and names the signal', () => {
		const verdict = detectEscalation({
			subject: 'Final notice',
			textBody: 'Our lawyer will be in touch about this.',
		});
		expect(verdict.level).toBe('escalate');
		expect(verdict.signals.map((signal) => signal.id)).toEqual(['legal-threat']);
		expect(summarizeVerdict(verdict)).toBe('Escalation signals detected (legal-threat).');
	});

	it('only watches a churn signal', () => {
		const verdict = detectEscalation({ textBody: 'We are not renewing next quarter.' });
		expect(verdict.level).toBe('watch');
		expect(verdict.signals).toEqual([{ id: 'churn', level: 'watch' }]);
	});

	it('takes the worst level when watch and escalate signals co-occur', () => {
		const verdict = detectEscalation({
			subject: 'Formal complaint',
			textBody: 'We are disputing the charge and not renewing.',
		});
		expect(verdict.level).toBe('escalate');
		expect(verdict.signals.map((signal) => signal.id)).toEqual([
			'chargeback',
			'churn',
			'complaint',
		]);
	});

	it('sees a phrase split by inline HTML markup', () => {
		const verdict = detectEscalation({
			htmlBody: '<p>We are sending a <b>cease and desist</b> letter.</p>',
		});
		expect(verdict.level).toBe('escalate');
		expect(verdict.signals.map((signal) => signal.id)).toEqual(['legal-threat']);
	});

	it('matches case-insensitively and across collapsed whitespace', () => {
		const verdict = detectEscalation({ textBody: 'CEASE\n\n   AND\tDESIST' });
		expect(verdict.level).toBe('escalate');
	});

	it('is unaffected by missing fields', () => {
		expect(detectEscalation({})).toEqual({ level: 'none', signals: [] });
	});

	it('does not scan beyond the bounded prefix of a single field', () => {
		const padded = `${'a'.repeat(MAX_SCAN_LENGTH)} cease and desist`;
		expect(detectEscalation({ textBody: padded }).level).toBe('none');
		expect(detectEscalation({ textBody: `cease and desist ${padded}` }).level).toBe('escalate');
	});

	it('reports one signal per rule, so MAX_SIGNALS really is the ceiling', () => {
		// One phrase from every rule, in one body.
		const verdict = detectEscalation({
			subject: 'Formal complaint',
			textBody:
				'Our lawyer is filing a GDPR complaint, we are disputing the charge, ' +
				'and we will cancel our contract.',
		});
		expect(verdict.signals.map((signal) => signal.id)).toEqual([
			'legal-threat',
			'regulator',
			'chargeback',
			'churn',
			'complaint',
		]);
		expect(verdict.signals).toHaveLength(MAX_SIGNALS);
		expect(new Set(verdict.signals.map((signal) => signal.id)).size).toBe(MAX_SIGNALS);
	});

	it('returns the same verdict for the same input', () => {
		const candidate = { subject: 'GDPR complaint', textBody: 'Filing with the ombudsman.' };
		expect(detectEscalation(candidate)).toEqual(detectEscalation(candidate));
	});
});

describe('level ordering helpers', () => {
	it('worstLevel picks the more severe level in both argument orders', () => {
		expect(worstLevel('none', 'watch')).toBe('watch');
		expect(worstLevel('watch', 'none')).toBe('watch');
		expect(worstLevel('watch', 'escalate')).toBe('escalate');
		expect(worstLevel('escalate', 'escalate')).toBe('escalate');
	});

	it('meetsLevel is inclusive of the threshold', () => {
		expect(meetsLevel('watch', 'watch')).toBe(true);
		expect(meetsLevel('escalate', 'watch')).toBe(true);
		expect(meetsLevel('watch', 'escalate')).toBe(false);
		expect(meetsLevel('none', 'watch')).toBe(false);
	});
});
