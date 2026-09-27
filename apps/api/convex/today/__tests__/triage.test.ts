/**
 * Where a conversation lands on a Workbench: people and alerts are important,
 * newsletters and the like are filed away (counted, never listed), and the two
 * corrections — unclassified mail uses the ingest heuristic, and a heuristic
 * `other` (no model refined it) reads as a person — hold.
 */

import { describe, expect, it } from 'vitest';
import { isAlertSubject, triageThread } from '../triage';

const heuristic = (label: string) => ({ label, source: 'heuristic' });
const llm = (label: string) => ({ label, source: 'llm' });

describe('workbench triage', () => {
	it('puts people first and files newsletters, promotions and spam away', () => {
		expect(triageThread({ category: heuristic('person'), subject: 'Lunch?' })).toEqual({
			bucket: 'important',
			reason: 'person',
		});
		for (const label of ['newsletter', 'promotion', 'spam', 'notification', 'receipt']) {
			expect(triageThread({ category: llm(label), subject: 'This week in tech' }).bucket).toBe(
				label
			);
		}
	});

	it('never lifts a newsletter or a promotion out, even with an urgent-sounding subject', () => {
		const subject = 'Action required: last chance, your offer expires tonight';
		expect(triageThread({ category: llm('newsletter'), subject }).bucket).toBe('newsletter');
		expect(triageThread({ category: llm('promotion'), subject }).bucket).toBe('promotion');
	});

	it('lifts notifications and receipts that ask for action', () => {
		expect(
			triageThread({ category: heuristic('notification'), subject: 'Security alert: new sign-in' })
		).toEqual({ bucket: 'important', reason: 'alert' });
		expect(
			triageThread({ category: heuristic('receipt'), subject: 'Your payment failed' })
		).toEqual({ bucket: 'important', reason: 'alert' });
		expect(
			triageThread({ category: heuristic('notification'), subject: 'Zahlung fehlgeschlagen' })
		).toEqual({ bucket: 'important', reason: 'alert' });
		// Routine notifications stay filed.
		expect(
			triageThread({ category: heuristic('notification'), subject: 'Your weekly summary' }).bucket
		).toBe('notification');
	});

	it('leaves one-time codes filed; they are stale minutes later', () => {
		expect(isAlertSubject('Your verification code is 123456')).toBe(false);
		expect(
			triageThread({ category: heuristic('notification'), subject: 'Your login code' }).bucket
		).toBe('notification');
	});

	it('reads an unrefined `other` as a person, and a model `other` as routine', () => {
		expect(triageThread({ category: heuristic('other'), subject: 'Project inquiry' })).toEqual({
			bucket: 'important',
			reason: 'new_sender',
		});
		expect(triageThread({ category: llm('other'), subject: 'Project inquiry' })).toEqual({
			bucket: 'routine',
			reason: null,
		});
		expect(
			triageThread({ category: { label: 'other', source: 'user' }, subject: 'x' }).bucket
		).toBe('routine');
	});

	it('uses the ingest heuristic for mail the classifier has not reached yet', () => {
		expect(
			triageThread({ category: null, heuristic: 'newsletter', subject: 'Issue #12' }).bucket
		).toBe('newsletter');
		expect(triageThread({ category: null, heuristic: null, subject: 'Hello' })).toEqual({
			bucket: 'important',
			reason: 'new_sender',
		});
		// A stored category always wins over the heuristic.
		expect(
			triageThread({ category: llm('person'), heuristic: 'newsletter', subject: 'Hi' }).bucket
		).toBe('important');
	});
});
