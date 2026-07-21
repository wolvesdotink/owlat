import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runSeedTest, SeedTestInputError, SEED_TEST_MAX_SEEDS } from '../jobs/seedTest.js';
import { main } from '../jobs/seedTestMain.js';
import { BUILTIN_JOB_COMMANDS, resolveJobCommand } from '../pluginTaskRunner.js';

interface SeedResult {
	seeds: number;
	inbox: number;
	promotions: number;
	spam: number;
	placementRate: number;
	placements: Array<{ address: string; folder: string }>;
}

const SHARED_FIXTURE = fileURLToPath(
	new URL('../../../../fixtures/deliverability-lab/seed-test-payload.json', import.meta.url)
);

const canonicalPayload = readFileSync(SHARED_FIXTURE, 'utf8');

describe('runSeedTest — the sandboxed Tier-3 analyzer', () => {
	it('accepts the canonical shared-fixture payload and returns a coherent result', () => {
		const result = JSON.parse(runSeedTest(canonicalPayload)) as SeedResult;
		expect(result.seeds).toBe(4);
		expect(result.inbox + result.promotions + result.spam).toBe(result.seeds);
		expect(result.placements).toHaveLength(result.seeds);
		expect(result.placementRate).toBeCloseTo(result.inbox / result.seeds, 10);
	});

	it('is deterministic — identical input always yields identical output', () => {
		expect(runSeedTest(canonicalPayload)).toBe(runSeedTest(canonicalPayload));
	});

	it('places more seeds in spam for a spam-heavy message than a clean one', () => {
		const seeds = Array.from({ length: 20 }, (_v, index) => `seed${index}@example.com`);
		const clean = JSON.parse(
			runSeedTest(JSON.stringify({ subject: 'April product update', seeds }))
		) as SeedResult;
		const spammy = JSON.parse(
			runSeedTest(
				JSON.stringify({
					subject: 'ACT NOW WINNER 100% FREE MONEY GUARANTEED',
					text: 'click here buy now limited time risk free',
					seeds,
				})
			)
		) as SeedResult;
		expect(spammy.spam).toBeGreaterThan(clean.spam);
	});

	it.each([
		['non-JSON', 'not json'],
		['a JSON array', '[]'],
		['a missing seeds array', JSON.stringify({ subject: 'x' })],
		['an empty seeds array', JSON.stringify({ subject: 'x', seeds: [] })],
		['a non-string seed', JSON.stringify({ subject: 'x', seeds: [42] })],
		[
			'too many seeds',
			JSON.stringify({
				subject: 'x',
				seeds: Array.from({ length: SEED_TEST_MAX_SEEDS + 1 }, (_v, i) => `s${i}@x.example`),
			}),
		],
	])('fails closed by throwing on %s', (_label, payload) => {
		expect(() => runSeedTest(payload)).toThrow(SeedTestInputError);
	});
});

describe('seedTestMain — the sandbox entrypoint', () => {
	it('writes the result to stdout and exits 0 on a valid payload', () => {
		const writes: string[] = [];
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		});
		const code = main(['node', 'seedTestMain', canonicalPayload]);
		spy.mockRestore();
		expect(code).toBe(0);
		expect(JSON.parse(writes.join(''))).toHaveProperty('placements');
	});

	it('exits non-zero on a malformed payload so the host records a failure', () => {
		const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		expect(main(['node', 'seedTestMain', 'not json'])).toBe(1);
		expect(main(['node', 'seedTestMain'])).toBe(1);
		spy.mockRestore();
	});
});

describe('BUILTIN_JOB_COMMANDS — seed-test wiring', () => {
	it('registers the seed-test kind and passes the payload as a DISCRETE argv element', () => {
		const payload = '{"seeds":["a@x.example"]; rm -rf /}'; // shell metacharacters, untrusted
		const spec = resolveJobCommand('plugin.deliverability-lab.seed-test', payload);
		expect(spec).not.toBeNull();
		expect(spec?.command).toBe('node');
		expect(spec?.args[0]).toMatch(/jobs\/seedTestMain\.js$/);
		// The raw payload is a standalone argv element — never spliced into a string.
		expect(spec?.args[1]).toBe(payload);
	});

	it('exposes seed-test as a host-controlled built-in, alongside selftest', () => {
		expect(Object.keys(BUILTIN_JOB_COMMANDS)).toEqual(
			expect.arrayContaining(['selftest', 'seed-test'])
		);
	});

	it('does not run a seed-test for another plugin id or a malformed kind', () => {
		expect(resolveJobCommand('plugin.other.seed-test', '{}')).not.toBeNull(); // any plugin may run a host built-in kind it owns
		expect(resolveJobCommand('seed-test', '{}')).toBeNull(); // not namespaced
		expect(resolveJobCommand('plugin.deliverability-lab.Seed-Test', '{}')).toBeNull(); // bad local id
	});
});
