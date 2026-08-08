/**
 * transportOutcomes — the PURE event vocabulary (plan D5).
 *
 * Which Send lifecycle transition is a transport outcome at all, and which
 * counter (plus its calibration twin, plan D8) an event bumps. No database, no
 * clock: these two functions are where the write path's meaning lives, so they
 * are asserted exhaustively and in isolation. The DB-side write path is
 * `transportOutcomes.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
	transportOutcomeCounters,
	transportOutcomeEventForTransition,
	type TransportOutcomeEvent,
} from '../transportOutcomeSummary';

describe('transportOutcomeEventForTransition (pure)', () => {
	it('maps every lifecycle transition that is a transport outcome', () => {
		expect(transportOutcomeEventForTransition('sent')).toBe('sent');
		expect(transportOutcomeEventForTransition('complained')).toBe('complained');
		expect(transportOutcomeEventForTransition('bounced', 'hard')).toBe('hard_bounced');
		expect(transportOutcomeEventForTransition('bounced', 'soft')).toBe('soft_bounced');
	});

	it('does not map `failed` — a local non-delivery is not a transport outcome', () => {
		expect(transportOutcomeEventForTransition('failed')).toBeNull();
	});

	it('does not map `opened`/`clicked` — the reducers emit those under the unique gate', () => {
		// Rationale lives on `transportOutcomeEventForTransition`.
		expect(transportOutcomeEventForTransition('opened')).toBeNull();
		expect(transportOutcomeEventForTransition('clicked')).toBeNull();
	});

	it('does not map `delivered` — the delivery observation emits it once per send', () => {
		// Rationale lives on `transportOutcomeEventForTransition`.
		expect(transportOutcomeEventForTransition('delivered')).toBeNull();
	});

	it('treats a bounce of unknown hardness as soft (the conservative side)', () => {
		expect(transportOutcomeEventForTransition('bounced')).toBe('soft_bounced');
	});
});

describe('transportOutcomeCounters (pure)', () => {
	const EVENTS: ReadonlyArray<[TransportOutcomeEvent, string]> = [
		['sent', 'sent'],
		['delivered', 'delivered'],
		['deferred', 'deferred'],
		['soft_bounced', 'softBounced'],
		['hard_bounced', 'hardBounced'],
		['complained', 'complained'],
		['opened', 'opened'],
		['clicked', 'clicked'],
		['unsubscribed', 'unsubscribed'],
	];

	it('bumps exactly one general counter per event', () => {
		for (const [event, counter] of EVENTS) {
			expect(transportOutcomeCounters(event, false)).toEqual([counter]);
		}
	});

	it('adds the calibration twin only for the three counters the gate reads', () => {
		expect(transportOutcomeCounters('sent', true)).toEqual(['sent', 'calibrationSent']);
		expect(transportOutcomeCounters('opened', true)).toEqual(['opened', 'calibrationOpened']);
		expect(transportOutcomeCounters('clicked', true)).toEqual(['clicked', 'calibrationClicked']);
	});

	it('keeps a calibration bounce/complaint in the general counter only', () => {
		expect(transportOutcomeCounters('hard_bounced', true)).toEqual(['hardBounced']);
		expect(transportOutcomeCounters('soft_bounced', true)).toEqual(['softBounced']);
		expect(transportOutcomeCounters('complained', true)).toEqual(['complained']);
		expect(transportOutcomeCounters('delivered', true)).toEqual(['delivered']);
	});
});
