import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	pluginWorkerJobKind,
	isPluginWorkerJobKindOwnedBy,
	parsePluginId,
} from '@owlat/plugin-kit';
import { describe, expect, it } from 'vitest';
import {
	buildSeedTestPayload,
	parseSeedTestResult,
	SeedTestPayloadError,
	SEED_TEST_LOCAL_ID,
	SEED_TEST_MAX_SEEDS,
	type SeedTestPayload,
	type SeedTestResult,
} from '../seedTest';
import { DELIVERABILITY_LAB_PLUGIN_ID } from '../constants';
import { CLEAN_EMAIL } from './fixtures';

const SHARED_FIXTURE = fileURLToPath(
	new URL('../../../../../fixtures/deliverability-lab/seed-test-payload.json', import.meta.url)
);

function validResult(seeds: number): SeedTestResult {
	const placements = Array.from({ length: seeds }, (_v, index) => ({
		address: `seed${index}@example.com`,
		folder: 'inbox' as const,
	}));
	return { seeds, inbox: seeds, promotions: 0, spam: 0, placementRate: 1, placements };
}

describe('buildSeedTestPayload', () => {
	it('namespaces the job kind to this plugin so the host can prove ownership', () => {
		const request = buildSeedTestPayload(CLEAN_EMAIL, ['a@x.example']);
		expect(request.jobKind).toBe(
			pluginWorkerJobKind(DELIVERABILITY_LAB_PLUGIN_ID, SEED_TEST_LOCAL_ID)
		);
		expect(isPluginWorkerJobKindOwnedBy(request.jobKind, DELIVERABILITY_LAB_PLUGIN_ID)).toBe(true);
		expect(isPluginWorkerJobKindOwnedBy(request.jobKind, parsePluginId('other-plugin'))).toBe(
			false
		);
	});

	it('de-duplicates and lowercases seed addresses', () => {
		const request = buildSeedTestPayload(CLEAN_EMAIL, [
			'A@X.example',
			'a@x.example',
			'b@x.example',
		]);
		const payload = JSON.parse(request.payload) as SeedTestPayload;
		expect(payload.seeds).toEqual(['a@x.example', 'b@x.example']);
	});

	it.each([
		['no seeds', [] as string[]],
		['a malformed address', ['not-an-email']],
		[
			'too many seeds',
			Array.from({ length: SEED_TEST_MAX_SEEDS + 1 }, (_v, i) => `s${i}@x.example`),
		],
	])('rejects %s with a typed error before enqueue', (_label, seeds) => {
		expect(() => buildSeedTestPayload(CLEAN_EMAIL, seeds)).toThrow(SeedTestPayloadError);
	});

	it('rejects a payload that would exceed the host byte ceiling', () => {
		const huge = { from: 'a@b.example', subject: 'x', html: 'y'.repeat(70_000) };
		expect(() => buildSeedTestPayload(huge, ['a@x.example'])).toThrow(SeedTestPayloadError);
	});
});

describe('parseSeedTestResult', () => {
	it('accepts a well-formed result', () => {
		expect(parseSeedTestResult(JSON.stringify(validResult(3)))).not.toBeNull();
	});

	it.each([
		['non-JSON', 'not json'],
		['a JSON array', '[]'],
		['counts that do not sum to seeds', JSON.stringify({ ...validResult(2), inbox: 5 })],
		['a placements length mismatch', JSON.stringify({ ...validResult(2), placements: [] })],
		['an out-of-range placement rate', JSON.stringify({ ...validResult(1), placementRate: 2 })],
		[
			'an unknown folder',
			JSON.stringify({
				seeds: 1,
				inbox: 1,
				promotions: 0,
				spam: 0,
				placementRate: 1,
				placements: [{ address: 'a@x', folder: 'junk' }],
			}),
		],
	])('fails closed to null on %s', (_label, json) => {
		expect(parseSeedTestResult(json)).toBeNull();
	});
});

describe('seed-test wire conformance (shared fixture)', () => {
	it('the builder emits the canonical payload shape the worker consumes', () => {
		const fixture = JSON.parse(readFileSync(SHARED_FIXTURE, 'utf8')) as SeedTestPayload;
		const request = buildSeedTestPayload(
			{ from: fixture.from, subject: fixture.subject, html: fixture.html, text: fixture.text },
			fixture.seeds
		);
		const emitted = JSON.parse(request.payload) as SeedTestPayload;
		expect(emitted.seeds).toEqual([...fixture.seeds]);
		expect(emitted.subject).toBe(fixture.subject);
		expect(emitted.from).toBe(fixture.from);
	});
});
