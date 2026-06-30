/**
 * Unit tests for the pure helpers in
 * `mail/postboxOutboundLifecycle.ts` — `parsePostboxMtaId` and
 * `deriveAggregateState`. No Convex setup; these are pure functions.
 *
 * See docs/adr/0012-postbox-outbound-lifecycle-module.md.
 */

import { describe, it, expect } from 'vitest';
import {
	parsePostboxMtaId,
	deriveAggregateState,
	type RecipientState,
} from '../mail/postboxOutboundLifecycle';

describe('parsePostboxMtaId', () => {
	it('parses a valid pb- prefixed id', () => {
		const out = parsePostboxMtaId('pb-msg_abc123-0');
		expect(out).not.toBeNull();
		expect(out?.mailMessageId).toBe('msg_abc123');
		expect(out?.idx).toBe(0);
	});

	it('parses non-zero idx', () => {
		const out = parsePostboxMtaId('pb-msg_xyz-42');
		expect(out?.idx).toBe(42);
	});

	it('returns null for non-pb prefix', () => {
		expect(parsePostboxMtaId('resend-abc')).toBeNull();
		expect(parsePostboxMtaId('abc')).toBeNull();
		expect(parsePostboxMtaId('')).toBeNull();
	});

	it('returns null when trailer is non-numeric', () => {
		expect(parsePostboxMtaId('pb-msg_abc-zero')).toBeNull();
		expect(parsePostboxMtaId('pb-msg_abc-')).toBeNull();
	});

	it('returns null when there is no trailer dash', () => {
		expect(parsePostboxMtaId('pb-msg_abc')).toBeNull();
	});

	it('splits on the LAST dash (Convex ids contain no dashes by convention)', () => {
		// Defensive: even if a future id format somehow embedded a dash,
		// the parser keys on the trailing `-<idx>` so the id part absorbs
		// everything else. `pb-msg_abc--1` parses to id=`msg_abc-`, idx=1.
		const out = parsePostboxMtaId('pb-msg_abc--1');
		expect(out?.idx).toBe(1);
		expect(out?.mailMessageId).toBe('msg_abc-');
	});
});

describe('deriveAggregateState', () => {
	const r = (state: RecipientState) => ({ state });

	it('all queued → queued', () => {
		expect(deriveAggregateState([r('queued'), r('queued'), r('queued')])).toBe(
			'queued'
		);
	});

	it('all sent → sent', () => {
		expect(deriveAggregateState([r('sent'), r('sent')])).toBe('sent');
	});

	it('all bounced → bounced', () => {
		expect(deriveAggregateState([r('bounced'), r('bounced')])).toBe('bounced');
	});

	it('all failed → failed', () => {
		expect(deriveAggregateState([r('failed')])).toBe('failed');
	});

	it('mix of sent + bounced → partial', () => {
		expect(deriveAggregateState([r('sent'), r('bounced')])).toBe('partial');
	});

	it('mix of sent + failed → partial', () => {
		expect(deriveAggregateState([r('sent'), r('failed')])).toBe('partial');
	});

	it('mix of queued + sent → partial (mid-dispatch)', () => {
		expect(deriveAggregateState([r('queued'), r('sent'), r('queued')])).toBe(
			'partial'
		);
	});

	it('single recipient: state is the aggregate', () => {
		expect(deriveAggregateState([r('sent')])).toBe('sent');
		expect(deriveAggregateState([r('bounced')])).toBe('bounced');
	});

	it('empty array → queued (defensive — never written empty)', () => {
		expect(deriveAggregateState([])).toBe('queued');
	});
});
