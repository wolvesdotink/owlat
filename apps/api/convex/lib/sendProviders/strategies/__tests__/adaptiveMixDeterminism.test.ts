/**
 * `adaptive_mix` — determinism and THE ANTI-COHORT PROOF (plan D7).
 *
 * Three properties, in ascending order of how badly their absence would
 * corrupt the controller:
 *
 *   1. STABLE. The same (contact, campaign, mixVersion) always lands in the
 *      same arm. A recipient that moved arms between two pages of one campaign
 *      would be counted in both denominators.
 *   2. RE-RANDOMIZED ON A VERSION BUMP. When the controller moves the share it
 *      bumps `mixVersion`, and the population is re-drawn. Without this the new
 *      share would be the old cohort plus a delta, and the added recipients
 *      would be systematically different from the ones already there.
 *   3. NOT A FIXED COHORT. A contact is not permanently in one arm across
 *      campaigns. This is the property the whole comparison rests on: salting
 *      with `contactId` alone would make the two arms two fixed groups of
 *      people, and every ratio the controller reads would be a measurement of
 *      cohort quality rather than of transport quality.
 */

import { describe, it, expect } from 'vitest';
import { decideMixAssignment, type MixArm } from '../adaptive_mix';
import { syntheticContactIds } from './fixtures';

const CELL = { ownShare: 0.5, mixVersion: 7 } as const;
const AUDIENCE = syntheticContactIds(5000);

function armFor(contactId: string, campaignId: string, mixVersion: number): MixArm {
	return decideMixAssignment({
		cell: { ownShare: 0.5, mixVersion },
		recipient: { contactId, campaignId },
	}).arm;
}

describe('adaptive_mix — determinism', () => {
	it('is stable for the same (contact, campaign, mixVersion)', () => {
		for (const contactId of AUDIENCE.slice(0, 500)) {
			const first = decideMixAssignment({
				cell: CELL,
				recipient: { contactId, campaignId: 'cmp-1' },
			});
			for (let repeat = 0; repeat < 3; repeat += 1) {
				const again = decideMixAssignment({
					cell: CELL,
					recipient: { contactId, campaignId: 'cmp-1' },
				});
				expect(again).toEqual(first);
			}
		}
	});

	it('re-randomizes on a mixVersion bump', () => {
		let moved = 0;
		for (const contactId of AUDIENCE) {
			if (armFor(contactId, 'cmp-1', 7) !== armFor(contactId, 'cmp-1', 8)) moved += 1;
		}
		// At s = 0.5 two independent draws disagree half the time. A hash that
		// ignored the version salt would move nobody; one that merely perturbed
		// it would move far fewer than half.
		expect(Math.abs(moved / AUDIENCE.length - 0.5)).toBeLessThan(0.03);
	});

	it('does not pin a contact to one arm across campaigns (the anti-cohort proof)', () => {
		const campaigns = ['cmp-1', 'cmp-2', 'cmp-3', 'cmp-4', 'cmp-5', 'cmp-6'];
		let alwaysSameArm = 0;
		for (const contactId of AUDIENCE) {
			const arms = new Set(campaigns.map((campaignId) => armFor(contactId, campaignId, 7)));
			if (arms.size === 1) alwaysSameArm += 1;
		}
		// With six independent fair draws, P(all six agree) = 2 * 0.5^6 ≈ 3.1%.
		// Salting with contactId ALONE would make this 100% — the fixed-cohort
		// bias D7 exists to prevent. The bound is generous enough not to flake
		// and tight enough that cohorting cannot hide under it.
		expect(alwaysSameArm / AUDIENCE.length).toBeLessThan(0.06);
	});

	it('gives two different contacts independent draws in the same campaign', () => {
		// The complement of the property above: within ONE campaign the arms must
		// still be a split of the population, not a function of the campaign.
		const arms = AUDIENCE.map((contactId) => armFor(contactId, 'cmp-9', 7));
		expect(arms.filter((arm) => arm === 'own').length).toBeGreaterThan(0);
		expect(arms.filter((arm) => arm === 'reference').length).toBeGreaterThan(0);
	});

	it('re-draws the arm per message when there is NO campaign (automation/transactional)', () => {
		// The `automation` and `transactional` streams pass a contact id and NO
		// campaign id (they are their own single-recipient experiments), so the
		// SEND id is the salt. Two properties have to hold at once: the arm must
		// be stable for repeated evaluations of ONE message (the enqueue record
		// and the dispatch replay must agree), and it must be re-drawn across
		// messages to the same contact — otherwise each contact is pinned to one
		// arm for the life of the mix version, and the two arms of those streams
		// become two fixed cohorts. `automation` is a first-class high-volume
		// stream, so this is not a transactional-only edge.
		const contactId = 'contact-no-campaign';
		const sendIds = syntheticContactIds(2000, 'snd');
		const armFrom = (fallbackKey: string): MixArm =>
			decideMixAssignment({ cell: CELL, recipient: { contactId, fallbackKey } }).arm;

		// Stable within one send.
		for (const fallbackKey of sendIds.slice(0, 50)) {
			expect(armFrom(fallbackKey)).toBe(armFrom(fallbackKey));
		}
		// Re-drawn across sends: at s = 0.5 both arms appear, near evenly.
		const own = sendIds.filter((fallbackKey) => armFrom(fallbackKey) === 'own').length;
		expect(Math.abs(own / sendIds.length - 0.5)).toBeLessThan(0.04);
	});

	it('the same contact is not pinned across two sends of the same stream', () => {
		const contactId = 'contact-pinned-check';
		const sendIds = syntheticContactIds(3000, 'pin');
		let sameArmRun = 0;
		for (const fallbackKey of sendIds) {
			const arm = decideMixAssignment({
				cell: CELL,
				recipient: { contactId, fallbackKey },
			}).arm;
			if (arm === 'own') sameArmRun += 1;
		}
		// A salt that ignored the send id would make this 0 or 3000.
		expect(sameArmRun).toBeGreaterThan(1000);
		expect(sameArmRun).toBeLessThan(2000);
	});

	it('treats a missing mixVersion as version 0, stably', () => {
		const withUndefined = decideMixAssignment({
			cell: { ownShare: 0.5 },
			recipient: { contactId: 'c-1', campaignId: 'cmp-1' },
		});
		const withZero = decideMixAssignment({
			cell: { ownShare: 0.5, mixVersion: 0 },
			recipient: { contactId: 'c-1', campaignId: 'cmp-1' },
		});
		expect(withUndefined).toEqual(withZero);
		expect(withUndefined.mixVersion).toBe(0);
	});
});
