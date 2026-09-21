/**
 * Golden-file determinism suite for `ostr-policy-v1`.
 *
 * Each `goldens/<name>.input.json` is a hand-authored scenario corpus; the
 * matching `goldens/<name>.golden` holds the RFC 8785 canonical form of the
 * `ScoreResult` the policy must produce for it, byte for byte. A policy change
 * that moves any number shows up as a reviewable diff of these files.
 *
 * REGENERATE (after an intentional policy change, and only then):
 *
 *     OSTR_UPDATE_GOLDENS=1 npx vitest run src/scoring
 *
 * The run rewrites every `.golden` and still asserts, so a regenerating run is
 * always green — inspect the resulting git diff, do not trust the exit code.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../../jcs.js';
import type { SequencedAttestation, SubjectRef, Tier } from '../../types.js';
import { scoreSubject } from '../score.js';

interface Scenario {
	description: string;
	subject: SubjectRef;
	asOf: string;
	entries: SequencedAttestation[];
}

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'goldens');
const UPDATE = process.env['OSTR_UPDATE_GOLDENS'] === '1';

/**
 * The tier each scenario name claims. Keeps the corpus honest about itself.
 *
 * Roughly half the corpus is adversarial: every exploit shape the policy is
 * supposed to refuse has a scenario here whose name states the refusal, so a
 * regression that re-opens one shows up as a golden diff rather than as a
 * silently green suite.
 */
const EXPECTED_TIERS: Record<string, Tier> = {
	'ancient-window-backdating-ignored': 'establishing',
	'appeal-excludes-evidence': 'establishing',
	'audited-observer-discounted': 'establishing',
	'bare-ip-evidence-groups-to-prefix': 'warned',
	'bare-ip-posture-from-stranger-ignored': 'unknown',
	'complaint-spike-warned': 'warned',
	'decayed-old-negative': 'establishing',
	'declared-ip-evidence-rolls-up': 'establishing',
	'establishing-low-volume-clean': 'establishing',
	'fresh-domain-posture-only': 'establishing',
	'impostor-appeal-ignored': 'unknown',
	'long-history-trusted': 'trusted',
	'multi-observer-negative-flagged': 'flagged',
	'poison-bounce-summary-clamped': 'establishing',
	'retraction-supersedes': 'establishing',
	'self-attested-traffic-earns-nothing': 'unknown',
	'single-hostile-observer-capped': 'unknown',
	'sybil-ring-backdated-history': 'establishing',
	'third-party-posture-ignored': 'establishing',
	'volume-less-report-batch-ignored': 'establishing',
	'vouch-stake-diluted-across-tenants': 'unknown',
	'vouched-newcomer': 'establishing',
};

const scenarioNames = readdirSync(GOLDEN_DIR)
	.filter((file) => file.endsWith('.input.json'))
	.map((file) => file.slice(0, -'.input.json'.length))
	.sort();

function loadScenario(name: string): Scenario {
	return JSON.parse(readFileSync(join(GOLDEN_DIR, `${name}.input.json`), 'utf8')) as Scenario;
}

describe('golden scenarios', () => {
	it('covers at least eight scenarios, spread over at least four tiers', () => {
		expect(scenarioNames.length).toBeGreaterThanOrEqual(8);
		const tiers = new Set(scenarioNames.map((name) => EXPECTED_TIERS[name]));
		expect(tiers.size).toBeGreaterThanOrEqual(4);
	});

	it('claims a tier for every scenario on disk', () => {
		const unclaimed = scenarioNames.filter((name) => EXPECTED_TIERS[name] === undefined);
		expect(unclaimed).toEqual([]);
	});

	for (const name of scenarioNames) {
		it(`${name} matches its golden byte for byte`, () => {
			const scenario = loadScenario(name);
			const result = scoreSubject({
				entries: scenario.entries,
				subject: scenario.subject,
				asOf: scenario.asOf,
			});
			const actual = `${canonicalize(result)}\n`;
			const goldenPath = join(GOLDEN_DIR, `${name}.golden`);
			if (UPDATE) writeFileSync(goldenPath, actual);
			expect(actual).toBe(readFileSync(goldenPath, 'utf8'));
		});

		it(`${name} lands in the tier its name claims`, () => {
			const scenario = loadScenario(name);
			const result = scoreSubject({
				entries: scenario.entries,
				subject: scenario.subject,
				asOf: scenario.asOf,
			});
			expect(result.tier).toBe(EXPECTED_TIERS[name]);
		});
	}
});
