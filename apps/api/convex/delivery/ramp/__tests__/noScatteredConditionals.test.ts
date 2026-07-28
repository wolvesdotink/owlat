/**
 * THE STRUCTURAL GUARD (plan D3) — the substitutions are DATA, or this fails.
 *
 * "A table that exists but is bypassed by an inline conditional somewhere in the
 * controller" is the exact failure mode this piece exists to prevent, and it is
 * not a failure any behavioural test would catch: the table would still be
 * right, the tests over it would still pass, and the controller would quietly
 * consult something else.
 *
 * So three source-level assertions, none of which a future edit can satisfy by
 * accident:
 *   1. no conditional on the DECISION PATH names an integration,
 *   2. the table has exactly ONE fold — `degradation.ts` — and the decision path
 *      reaches its constants only through it,
 *   3. every table entry is exercised: it governs at least one real cell, and
 *      every declared substitution source is reachable from some absence.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DESTINATION_PROVIDER_KEYS } from '@owlat/shared/deliverabilityRouting';
import { resolveRampDegradation } from '../degradation';
import {
	entryAppliesToProvider,
	RAMP_DEGRADATION_MATRIX,
	RAMP_FULLY_EQUIPPED,
	RAMP_INTEGRATION_IDS,
	RAMP_SUBSTITUTE_SOURCES,
	type RampIntegrationId,
	type RampIntegrationPresence,
} from '../degradationMatrix';

const here = dirname(fileURLToPath(import.meta.url));
const rampDir = join(here, '..');
const deliveryDir = join(rampDir, '..');

/** The modules that DECIDE. A substitution may not hide in any of them. */
const DECISION_PATH: readonly string[] = [
	join(rampDir, 'controller.ts'),
	join(rampDir, 'controllerBounds.ts'),
	join(rampDir, 'controllerConfig.ts'),
	join(rampDir, 'gates.ts'),
	join(rampDir, 'gateEvaluation.ts'),
	join(deliveryDir, 'rampControllerInputs.ts'),
	join(deliveryDir, 'rampControllerCron.ts'),
];

/**
 * The vocabulary of an INTEGRATION. Deliberately not `reference` or `seed` on
 * their own — the reference ARM and the seed PLACEMENT GATE are measurements the
 * decision path is supposed to name. What it may not name is whether a
 * third-party ACCOUNT exists.
 */
const INTEGRATION_VOCABULARY =
	/\b(snds|postmaster|reference_transport|seed_mailboxes|commercial_placement|feedback_loop|hasRelay|hasEsp|cfbl)\b/i;

function sourceWithoutComments(file: string): string {
	return readFileSync(file, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

describe('no conditional on the decision path names an integration', () => {
	for (const file of DECISION_PATH) {
		it(`${basename(file)} branches on measurements, never on accounts`, () => {
			const offending = sourceWithoutComments(file)
				.split('\n')
				.filter((line) => /\bif\s*\(|\?/.test(line))
				.filter((line) => INTEGRATION_VOCABULARY.test(line));
			expect(offending).toEqual([]);
		});
	}
});

describe('the table has exactly one fold', () => {
	it('only degradation.ts reads the matrix', () => {
		const readers = DECISION_PATH.filter((file) =>
			/RAMP_DEGRADATION_MATRIX|RAMP_DEGRADATION_BY_INTEGRATION/.test(sourceWithoutComments(file))
		);
		expect(readers).toEqual([]);
	});

	it('the decision path takes its constants through the fold', () => {
		const inputs = sourceWithoutComments(join(deliveryDir, 'rampControllerInputs.ts'));
		expect(inputs).toMatch(/resolveRampDegradation\(/);
		expect(inputs).toMatch(/degradedStreamConfig\(/);
		expect(inputs).toMatch(/degradedCeilingCap\(/);
		expect(inputs).toMatch(/usesTrailingBaseline\(/);
	});
});

function absent(id: RampIntegrationId): RampIntegrationPresence {
	const presence: Record<RampIntegrationId, boolean> = { ...RAMP_FULLY_EQUIPPED };
	presence[id] = false;
	return presence;
}

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
