/**
 * THE STRUCTURAL GUARD (plan D3) — the substitutions are DATA, or this fails.
 *
 * The source-level half (no conditional on the decision path names an
 * integration; the table has exactly ONE fold, `degradation.ts`, and the
 * decision path reaches its constants only through it) is
 * `scripts/check-ramp-decision-path.sh`, part of `bun run lint`. What stays here
 * is the data half: every table entry is exercised — it governs at least one
 * real cell, and every declared substitution source is reachable from some
 * absence.
 */

import { describe, expect, it } from 'vitest';
import { DESTINATION_PROVIDER_KEYS } from '@owlat/shared/deliverabilityRouting';
import { resolveRampDegradation } from '../degradation';
import { absent } from './controllerFixtures';
import {
	entryAppliesToProvider,
	RAMP_DEGRADATION_MATRIX,
	RAMP_INTEGRATION_IDS,
	RAMP_SUBSTITUTE_SOURCES,
} from '../degradationMatrix';

describe('every table entry is exercised', () => {
	it('declares an entry for every integration, and no orphan entries', () => {
		expect(RAMP_DEGRADATION_MATRIX.map((entry) => entry.integration).sort()).toEqual(
			[...RAMP_INTEGRATION_IDS].sort()
		);
	});

	for (const entry of RAMP_DEGRADATION_MATRIX) {
		it(`${entry.integration} governs at least one real cell`, () => {
			const providers = DESTINATION_PROVIDER_KEYS.filter((provider) =>
				entryAppliesToProvider(entry, provider)
			);
			expect(providers.length).toBeGreaterThan(0);
			for (const provider of providers) {
				const degradation = resolveRampDegradation({
					presence: absent(entry.integration),
					provider,
				});
				expect(degradation.absent.map((row) => row.integration)).toContain(entry.integration);
			}
		});
	}

	it('every declared substitution source is reachable from some absence', () => {
		const reachable = new Set(RAMP_DEGRADATION_MATRIX.flatMap((entry) => [...entry.substitutes]));
		for (const source of RAMP_SUBSTITUTE_SOURCES) {
			expect(reachable.has(source)).toBe(true);
		}
	});

	it('every entry that changes a constant is observable through the fold', () => {
		for (const entry of RAMP_DEGRADATION_MATRIX) {
			const provider = DESTINATION_PROVIDER_KEYS.find((key) => entryAppliesToProvider(entry, key));
			expect(provider).toBeDefined();
			if (provider === undefined) continue;
			const degradation = resolveRampDegradation({ presence: absent(entry.integration), provider });
			const changesSomething =
				entry.cleanWindowsRequired !== undefined ||
				entry.stepMultiplier !== undefined ||
				entry.dwellMultiplier !== undefined ||
				entry.ceilingPhaseDelta !== undefined ||
				entry.complaintMaxOverride !== undefined ||
				entry.paceCeilingDay !== undefined;
			const observed =
				degradation.cleanWindowsRequired !== undefined ||
				degradation.stepMultiplier !== 1 ||
				degradation.dwellMultiplier !== 1 ||
				degradation.ceilingPhaseDelta !== 0 ||
				degradation.complaintMaxOverride !== undefined ||
				degradation.paceCeilingDay !== undefined;
			expect(observed).toBe(changesSomething);
		}
	});
});
