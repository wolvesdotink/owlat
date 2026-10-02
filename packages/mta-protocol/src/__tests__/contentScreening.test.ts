import { describe, expect, it } from 'vitest';
import { normalizeContentScreeningVerdict } from '../contentScreening';

describe('normalizeContentScreeningVerdict', () => {
	it('keeps a well-formed verdict as it is', () => {
		const verdict = {
			enabled: true,
			verdict: 'reject',
			reason: 'spam_score',
			sizeLimitKb: 500,
			spam: { score: 16.2, threshold: 15 },
		};
		expect(normalizeContentScreeningVerdict(verdict)).toEqual(verdict);
	});

	it('keeps the matched blocklist pattern', () => {
		expect(
			normalizeContentScreeningVerdict({
				enabled: true,
				verdict: 'reject',
				reason: 'blocked_url',
				blockedPattern: 'bad.example',
				sizeLimitKb: 500,
			})
		).toEqual({
			enabled: true,
			verdict: 'reject',
			reason: 'blocked_url',
			blockedPattern: 'bad.example',
			sizeLimitKb: 500,
		});
	});

	it('rejects an answer without the fields the check needs', () => {
		expect(normalizeContentScreeningVerdict(null)).toBeNull();
		expect(normalizeContentScreeningVerdict({ enabled: true, verdict: 'maybe' })).toBeNull();
		expect(
			normalizeContentScreeningVerdict({ enabled: 'yes', verdict: 'accept', sizeLimitKb: 500 })
		).toBeNull();
		expect(normalizeContentScreeningVerdict({ enabled: true, verdict: 'accept' })).toBeNull();
	});

	it('drops an unknown reason and a malformed spam score instead of trusting them', () => {
		expect(
			normalizeContentScreeningVerdict({
				enabled: true,
				verdict: 'reject',
				reason: 'cosmic_rays',
				sizeLimitKb: 500,
				spam: { score: 'high', threshold: 15 },
			})
		).toEqual({ enabled: true, verdict: 'reject', sizeLimitKb: 500 });
	});
});
