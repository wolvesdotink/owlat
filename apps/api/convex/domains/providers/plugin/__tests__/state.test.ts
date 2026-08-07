/**
 * THE UNTRUSTED BOUNDARY of the plugin domain identity (the seams plan's P3.2).
 *
 * `parsePluginRelayResult` reads whatever a third-party module returned and turns
 * it into the only shape anything downstream sees. Every judgement it makes is
 * one the host refuses to let a plugin make, so each is asserted here rather than
 * exercised through a network mock:
 *
 *  - the STATUS is derived, never declared. A module cannot report a domain
 *    verified while telling us its DKIM record is invalid, because it does not
 *    get to report a status at all;
 *  - a shape we cannot read is `unavailable`, never a verdict. The three outcomes
 *    differ in what they may overwrite — only `ok` refreshes the proof's age,
 *    only `auth_failed` condemns a credential — so a malformed response must land
 *    on the one that changes nothing but the retry;
 *  - the DNS facts are bounded, because the alignment pre-flight resolves them
 *    LIVE and an unbounded list is an unbounded number of lookups driven by a
 *    manifest.
 */

import { describe, expect, it } from 'vitest';
import {
	PLUGIN_DOMAIN_IDENTITY_MAX_DNS_FACT_LENGTH,
	PLUGIN_DOMAIN_IDENTITY_MAX_DNS_FACTS,
	PLUGIN_DOMAIN_IDENTITY_MAX_ERROR_LENGTH,
} from '@owlat/plugin-kit';
import {
	buildFailedPluginProviderDetails,
	buildPluginProviderDetails,
	nextPluginCheckDueAt,
	parsePluginRelayResult,
	PLUGIN_CHECK_INTERVAL_MS,
	PLUGIN_DENIED_RETRY_MS,
	PLUGIN_RELAY_PROOF_MAX_AGE_MS,
	PLUGIN_UNAVAILABLE_RETRY_MS,
	readPluginProviderDetails,
} from '../state';

function state(overrides: Record<string, unknown> = {}) {
	return {
		isOwnershipVerified: true,
		spf: { isValid: true },
		dkim: { isValid: true },
		dkimSelectors: ['pm-bounces'],
		spfMechanisms: ['include:spf.example.net'],
		...overrides,
	};
}

function ok(overrides: Record<string, unknown> = {}) {
	return { outcome: 'ok', state: state(overrides) };
}

describe('the status is derived from observations, never declared', () => {
	it('is verified only when ownership, SPF, DKIM and the DNS are all there', () => {
		const result = parsePluginRelayResult(ok());

		expect(result).toEqual({
			outcome: 'ok',
			observation: {
				status: 'verified',
				spf: { isValid: true },
				dkim: { isValid: true },
				dkimSelectors: ['pm-bounces'],
				spfMechanisms: ['include:spf.example.net'],
			},
		});
	});

	it.each([
		['ownership has not cleared', { isOwnershipVerified: false }],
		['SPF is invalid', { spf: { isValid: false } }],
		['DKIM is invalid', { dkim: { isValid: false } }],
	])('is pending_dns when %s', (_label, overrides) => {
		// Not `verified`, and not `unverified` either: the DNS is describable, so
		// there is something concrete an operator is waiting on.
		const result = parsePluginRelayResult(ok(overrides));

		expect(result).toMatchObject({ outcome: 'ok', observation: { status: 'pending_dns' } });
	});

	it('is unverified when the module could not describe the DNS at all', () => {
		// Nothing for an operator to be waiting on, and nothing an arm could be
		// built from.
		const result = parsePluginRelayResult(ok({ dkimSelectors: [] }));

		expect(result).toMatchObject({ outcome: 'ok', observation: { status: 'unverified' } });
	});

	it('ignores a status the module tried to declare', () => {
		// The one thing a plugin must not be able to say. A module claiming
		// `verified` over invalid records would license relaying a customer's
		// domain on its own say-so.
		const result = parsePluginRelayResult({
			outcome: 'ok',
			state: { ...state({ dkim: { isValid: false } }), status: 'verified' },
		});

		expect(result).toMatchObject({ outcome: 'ok', observation: { status: 'pending_dns' } });
	});
});

describe('a shape the host cannot read is unavailable, never a verdict', () => {
	it.each([
		['a non-object', 'yes'],
		['null', null],
		['an array', []],
		['an unknown outcome', { outcome: 'maybe' }],
		['no outcome at all', {}],
		['ok with no state', { outcome: 'ok' }],
		['ok with a non-object state', { outcome: 'ok', state: 'fine' }],
		['ok with no SPF verdict', { outcome: 'ok', state: state({ spf: undefined }) }],
		[
			'ok with a non-boolean DKIM verdict',
			{ outcome: 'ok', state: state({ dkim: { isValid: 'y' } }) },
		],
		['ok with no ownership verdict', { outcome: 'ok', state: state({ isOwnershipVerified: 'y' }) }],
	])('reads %s as unavailable', (_label, input) => {
		expect(parsePluginRelayResult(input)).toMatchObject({ outcome: 'unavailable' });
	});

	it('keeps the two non-verdict outcomes distinguishable', () => {
		// They are not interchangeable: a rejected credential is terminal and an
		// operator has to fix it, while an outage leaves the identity untouched and
		// only moves the retry.
		expect(parsePluginRelayResult({ outcome: 'auth_failed', error: 'bad key' })).toEqual({
			outcome: 'auth_failed',
			error: 'bad key',
		});
		expect(parsePluginRelayResult({ outcome: 'unavailable', error: '502' })).toEqual({
			outcome: 'unavailable',
			error: '502',
		});
	});

	it('never leaves an error unreported, and never lets one be unbounded', () => {
		expect(parsePluginRelayResult({ outcome: 'auth_failed' })).toEqual({
			outcome: 'auth_failed',
			error: 'no detail reported',
		});
		const long = parsePluginRelayResult({ outcome: 'unavailable', error: 'x'.repeat(5_000) });
		expect(long).toMatchObject({ outcome: 'unavailable' });
		expect((long as { error: string }).error).toHaveLength(PLUGIN_DOMAIN_IDENTITY_MAX_ERROR_LENGTH);
	});
});

describe('the DNS facts are bounded, deduplicated and trimmed', () => {
	it('drops everything that is not a usable DNS string', () => {
		const result = parsePluginRelayResult(
			ok({
				dkimSelectors: ['  pm-bounces  ', 'pm-bounces', '', 42, null, 'x'.repeat(300), 'second'],
			})
		);

		expect(result).toMatchObject({
			observation: { dkimSelectors: ['pm-bounces', 'second'] },
		});
	});

	it('caps the count a manifest can drive the pre-flight to resolve', () => {
		const many = Array.from({ length: 50 }, (_, index) => `selector-${index}`);
		const result = parsePluginRelayResult(ok({ dkimSelectors: many, spfMechanisms: many }));

		expect(result).toMatchObject({
			observation: {
				dkimSelectors: many.slice(0, PLUGIN_DOMAIN_IDENTITY_MAX_DNS_FACTS),
				spfMechanisms: many.slice(0, PLUGIN_DOMAIN_IDENTITY_MAX_DNS_FACTS),
			},
		});
	});

	it('accepts a fact exactly at the length cap', () => {
		const atCap = 'a'.repeat(PLUGIN_DOMAIN_IDENTITY_MAX_DNS_FACT_LENGTH);
		const result = parsePluginRelayResult(ok({ dkimSelectors: [atCap] }));

		expect(result).toMatchObject({ observation: { dkimSelectors: [atCap] } });
	});

	it('reads back only what it stored, and empties on anything odd', () => {
		const observation = parsePluginRelayResult(ok());
		const stored = JSON.stringify(
			buildPluginProviderDetails(
				(observation as { observation: Parameters<typeof buildPluginProviderDetails>[0] })
					.observation
			)
		);

		expect(readPluginProviderDetails(stored)).toEqual({
			dkimSelectors: ['pm-bounces'],
			spfMechanisms: ['include:spf.example.net'],
		});
		for (const raw of [undefined, 'not json', '[]', 'null', '{"dkimSelectors":"one"}']) {
			expect({ raw, read: readPluginProviderDetails(raw) }).toEqual({
				raw,
				read: { dkimSelectors: [], spfMechanisms: [] },
			});
		}
	});
});

describe('the re-check cadence keeps a live proof inside the freshness bound', () => {
	it('re-asks a verified identity far sooner than the proof expires', () => {
		// If it did not, a deployment would lose the ability to relay a domain that
		// nothing is wrong with — the failure a bound with no sweep behind it has.
		expect(PLUGIN_CHECK_INTERVAL_MS.verified).toBeLessThan(PLUGIN_RELAY_PROOF_MAX_AGE_MS / 2);
		expect(nextPluginCheckDueAt('verified', 1_000)).toBe(1_000 + PLUGIN_CHECK_INTERVAL_MS.verified);
	});

	it('backs off on a credential the provider already rejected', () => {
		// Re-asking hard would hammer a provider's auth surface with a key it has
		// rejected; the fix is an operator action, not a retry.
		expect(PLUGIN_CHECK_INTERVAL_MS.failed).toBeGreaterThan(PLUGIN_CHECK_INTERVAL_MS.pending_dns);
	});

	it('waits out a denial far longer than an outage', () => {
		// A denial is a decision, not a moment: the plugin is off, or its grant is
		// revoked, and it clears when an operator says so. Riding that out at the
		// outage cadence would schedule an action and write an audit row every
		// fifteen minutes per domain for as long as the operator leaves it off.
		expect(PLUGIN_DENIED_RETRY_MS).toBeGreaterThan(PLUGIN_UNAVAILABLE_RETRY_MS);
	});
});

describe('a failure blob carries its reason without discarding the DNS facts', () => {
	it('keeps what the last observation recorded, and adds the reason', () => {
		// The selectors describe what the provider signs this domain under, which a
		// rejected credential says nothing about — and the alignment pre-flight still
		// resolves them to describe the second arm.
		const observation = parsePluginRelayResult(ok());
		const stored = JSON.stringify(
			buildPluginProviderDetails(
				(observation as { observation: Parameters<typeof buildPluginProviderDetails>[0] })
					.observation
			)
		);

		expect(buildFailedPluginProviderDetails(stored, 'invalid token')).toEqual({
			kind: 'plugin',
			dkimSelectors: ['pm-bounces'],
			spfMechanisms: ['include:spf.example.net'],
			lastError: 'invalid token',
		});
	});

	it('is still a complete, typed blob when there was nothing stored to keep', () => {
		expect(buildFailedPluginProviderDetails(undefined, 'no key')).toEqual({
			kind: 'plugin',
			dkimSelectors: [],
			spfMechanisms: [],
			lastError: 'no key',
		});
	});
});
