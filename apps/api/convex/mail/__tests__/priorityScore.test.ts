/**
 * Pure-helper coverage for the Reply Queue unified priority score
 * (mail/priorityScore.ts): the deterministic sender-importance signal blended
 * with the LLM urgency, and the HEY-style first-time-sender screener gate.
 */
import { describe, it, expect } from 'vitest';
import {
	computePriorityScore,
	senderImportanceScore,
	isScreenedOut,
	urgencyFallbackScore,
	type SenderSignal,
} from '../priorityScore';

describe('senderImportanceScore', () => {
	it('saturates for an explicit VIP regardless of other signals', () => {
		expect(senderImportanceScore({ isVip: true })).toBe(100);
		expect(senderImportanceScore({ isVip: true, frecency: 0, isKnownContact: false })).toBe(100);
	});

	it('scores an unknown first-time sender as a stranger (0)', () => {
		expect(senderImportanceScore({})).toBe(0);
	});

	it('rewards a known, frequently-mailed contact over a stranger', () => {
		const frecent = senderImportanceScore({ isKnownContact: true, frecency: 150 });
		const stranger = senderImportanceScore({});
		expect(frecent).toBeGreaterThan(stranger);
		// person base (30) + capped frecency (50) = 80.
		expect(frecent).toBe(80);
	});

	it('never lets a non-VIP contact reach the VIP ceiling', () => {
		const maxNonVip = senderImportanceScore({
			isKnownContact: true,
			frecency: 10_000,
			accepted: true,
		});
		expect(maxNonVip).toBeLessThan(100);
	});
});

describe('computePriorityScore', () => {
	const terse = { urgency: 'low' as const };
	const wordy = { urgency: 'high' as const };

	it('ranks a VIP terse note above a wordy stranger', () => {
		const vipTerse = computePriorityScore({ ...terse, sender: { isVip: true } });
		const strangerWordy = computePriorityScore({ ...wordy, sender: {} });
		expect(vipTerse).toBeGreaterThan(strangerWordy);
	});

	it('ranks a known frecent contact terse note above a wordy stranger', () => {
		const contactTerse = computePriorityScore({
			...terse,
			sender: { isKnownContact: true, frecency: 150 },
		});
		const strangerWordy = computePriorityScore({ ...wordy, sender: {} });
		expect(contactTerse).toBeGreaterThan(strangerWordy);
	});

	it('lets the explicit VIP flag dominate at equal urgency', () => {
		const urgency = 'normal' as const;
		const vip = computePriorityScore({ urgency, sender: { isVip: true } });
		const knownContact = computePriorityScore({
			urgency,
			sender: { isKnownContact: true, frecency: 150 },
		});
		const unknown = computePriorityScore({ urgency, sender: {} });
		expect(vip).toBeGreaterThan(knownContact);
		expect(knownContact).toBeGreaterThan(unknown);
	});

	it('is monotonic in urgency for a fixed sender', () => {
		const sender: SenderSignal = { isKnownContact: true, frecency: 40 };
		const high = computePriorityScore({ urgency: 'high', sender });
		const normal = computePriorityScore({ urgency: 'normal', sender });
		const low = computePriorityScore({ urgency: 'low', sender });
		expect(high).toBeGreaterThan(normal);
		expect(normal).toBeGreaterThan(low);
	});
});

describe('isScreenedOut', () => {
	it('is a no-op when the screener is off (never changes today behaviour)', () => {
		expect(isScreenedOut({ screenerEnabled: false, sender: {} })).toBe(false);
	});

	it('gates a first-time / unknown sender when the screener is on', () => {
		expect(isScreenedOut({ screenerEnabled: true, sender: {} })).toBe(true);
	});

	it('always lets a VIP, known contact, or accepted sender through', () => {
		expect(isScreenedOut({ screenerEnabled: true, sender: { isVip: true } })).toBe(false);
		expect(isScreenedOut({ screenerEnabled: true, sender: { isKnownContact: true } })).toBe(false);
		expect(isScreenedOut({ screenerEnabled: true, sender: { accepted: true } })).toBe(false);
	});
});

describe('urgencyFallbackScore', () => {
	it('orders the buckets high > normal > low', () => {
		expect(urgencyFallbackScore('high')).toBeGreaterThan(urgencyFallbackScore('normal'));
		expect(urgencyFallbackScore('normal')).toBeGreaterThan(urgencyFallbackScore('low'));
	});
});
