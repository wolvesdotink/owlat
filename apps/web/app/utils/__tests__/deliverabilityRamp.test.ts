/**
 * THE RELAY-REMOVAL CONSEQUENCE SENTENCE — one helper, three surfaces.
 *
 * The Independence screen, the transport editor's dialog and the apply
 * endpoint's refusal all name the same consequence for the same click, and an
 * operator meets at least two of them in a single attempt to disconnect. So the
 * facts-to-words step is pinned HERE, once, rather than three times in three
 * mounted screens: what it says about one dependent cell, about a count it does
 * not have, and about a relay it could not name.
 */
import { describe, expect, it } from 'vitest';
import { relayRemovalConsequenceCopy } from '~/utils/deliverabilityRamp';

const REFERENCE = 'ses';

describe('relayRemovalConsequenceCopy', () => {
	it('agrees with itself about one cell — subject, verb and possessive', () => {
		const { consequence } = relayRemovalConsequenceCopy({
			dependentCells: ['campaign:gmail'],
			referenceTransportId: REFERENCE,
			projectedSafeAt: null,
		});

		expect(consequence).toContain('1 cell has not graduated yet');
		expect(consequence).toContain('still sends part of its mail through ses');
		// The defect this pins: "1 cells have not graduated yet", shipped on two
		// screens while the server's own refusal got it right.
		expect(consequence).not.toContain('1 cells');
	});

	it('pluralises past one', () => {
		const { consequence } = relayRemovalConsequenceCopy({
			dependentCells: ['campaign:gmail', 'automation:yahoo'],
			referenceTransportId: REFERENCE,
			projectedSafeAt: null,
		});

		expect(consequence).toContain('2 cells have not graduated yet');
		expect(consequence).toContain('still send part of their mail through ses');
	});

	it('names the consequence itself, not the risk in general', () => {
		const { consequence } = relayRemovalConsequenceCopy({
			dependentCells: ['campaign:gmail'],
			referenceTransportId: REFERENCE,
			projectedSafeAt: null,
		});

		expect(consequence).toContain('immediately — not gradually');
		expect(consequence).toContain('stops being available to fall back on');
	});

	it('says the situation could not be established rather than claiming zero cells', () => {
		// A COUNT WE DO NOT HAVE IS NOT ZERO. This is the shape behind the
		// endpoint's fail-closed refusal — nothing was read, so nothing may be
		// asserted about which cells are safe.
		for (const dependentCells of [null, []]) {
			const { consequence } = relayRemovalConsequenceCopy({
				dependentCells,
				referenceTransportId: null,
				projectedSafeAt: null,
			});

			expect(consequence).toContain('could not be established');
			expect(consequence).not.toContain('0 cell');
			expect(consequence).toContain('immediately — not gradually');
		}
	});

	it('calls an unnamed second arm the relay rather than printing null', () => {
		const { consequence } = relayRemovalConsequenceCopy({
			dependentCells: null,
			referenceTransportId: null,
			projectedSafeAt: null,
		});

		expect(consequence).toContain('the relay');
		expect(consequence).not.toContain('null');
	});

	it('offers the projected safe date only when the projection has one', () => {
		const at = Date.UTC(2026, 7, 14);
		expect(
			relayRemovalConsequenceCopy({
				dependentCells: ['campaign:gmail'],
				referenceTransportId: REFERENCE,
				projectedSafeAt: at,
			}).safeDate
		).toContain('waiting until about');
		expect(
			relayRemovalConsequenceCopy({
				dependentCells: ['campaign:gmail'],
				referenceTransportId: REFERENCE,
				projectedSafeAt: null,
			}).safeDate
		).toBeNull();
	});
});
