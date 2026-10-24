/**
 * The frozen fixtures, held to the contract on their own: each is an EXACT
 * producer answer (`returns`, unknown keys refused), each is something the
 * worker accepts, and the legacy ones are answers no current backend gives.
 * The producer side (apps/api) and the consumer side (apps/imap,
 * apps/mail-sync) are pinned against the same values in their own suites.
 */

import { describe, expect, it } from 'vitest';
import type { AnyWorkerEndpoint } from '../contract';
import { IMAP_ENDPOINTS } from '../imap/index';
import { MAIL_SYNC_ENDPOINTS } from '../mailSync/index';
import { validatorMismatch } from '../validatorMatch';
import {
	bindWirePlaceholders,
	IMAP_WIRE_FIXTURES,
	MAIL_SYNC_LEGACY_WIRE_FIXTURES,
	MAIL_SYNC_WIRE_FIXTURES,
	type WireFixtureCase,
} from '../wireFixtures/index';

type Case = [string, AnyWorkerEndpoint, WireFixtureCase<unknown>];

function casesOf(
	worker: string,
	registry: Record<string, AnyWorkerEndpoint>,
	fixtures: Record<string, readonly WireFixtureCase<unknown>[]>
): Case[] {
	return Object.entries(fixtures).flatMap(([key, cases]) =>
		cases.map((fixture): Case => [`${worker} ${key}: ${fixture.name}`, registry[key]!, fixture])
	);
}

const CURRENT = [
	...casesOf('IMAP', IMAP_ENDPOINTS, IMAP_WIRE_FIXTURES),
	...casesOf('mail-sync', MAIL_SYNC_ENDPOINTS, MAIL_SYNC_WIRE_FIXTURES),
];
const LEGACY = casesOf('mail-sync', MAIL_SYNC_ENDPOINTS, MAIL_SYNC_LEGACY_WIRE_FIXTURES);

describe('frozen wire fixtures', () => {
	it('cover every endpoint of both registries', () => {
		expect(Object.keys(IMAP_WIRE_FIXTURES).sort()).toEqual(Object.keys(IMAP_ENDPOINTS).sort());
		expect(Object.keys(MAIL_SYNC_WIRE_FIXTURES).sort()).toEqual(
			Object.keys(MAIL_SYNC_ENDPOINTS).sort()
		);
	});

	it('name each case once per endpoint', () => {
		for (const fixtures of [IMAP_WIRE_FIXTURES, MAIL_SYNC_WIRE_FIXTURES]) {
			for (const [key, cases] of Object.entries(fixtures)) {
				const names = (cases as readonly WireFixtureCase<unknown>[]).map((c) => c.name);
				expect(new Set(names).size, key).toBe(names.length);
			}
		}
	});

	it.each(CURRENT)('%s is an exact producer answer', (_name, endpoint, fixture) => {
		expect(validatorMismatch(endpoint.returns, fixture.value)).toBeNull();
	});

	it.each(CURRENT)('%s is accepted by the worker', (_name, endpoint, fixture) => {
		expect(
			validatorMismatch(endpoint.accepts, fixture.value, { unknownKeys: 'ignore' })
		).toBeNull();
	});

	it.each(LEGACY)(
		'%s is accepted, but produced by no current backend',
		(_name, endpoint, fixture) => {
			expect(
				validatorMismatch(endpoint.accepts, fixture.value, { unknownKeys: 'ignore' })
			).toBeNull();
			expect(validatorMismatch(endpoint.returns, fixture.value)).not.toBeNull();
		}
	);
});

describe('bindWirePlaceholders', () => {
	it('replaces every placeholder, at any depth', () => {
		expect(
			bindWirePlaceholders(
				{ id: '@wire/a', rows: [{ id: '@wire/a', other: 'plain' }], n: 1, none: null },
				{ '@wire/a': 'k17abc' }
			)
		).toEqual({ id: 'k17abc', rows: [{ id: 'k17abc', other: 'plain' }], n: 1, none: null });
	});

	it('refuses to leave a placeholder unbound', () => {
		expect(() => bindWirePlaceholders(['@wire/missing'], {})).toThrow(
			/@wire\/missing is not bound/
		);
	});
});
