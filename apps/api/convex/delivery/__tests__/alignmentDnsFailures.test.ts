/**
 * Adversarial DNS semantics at the gather boundary (P3-5).
 *
 * This is the layer where a lookup failure could be quietly laundered into
 * "aligned" (letting a misconfigured cell ramp) or into "no record" (raising an
 * alarm about a configuration that may be fine). Every other DNS read in this
 * backend fails soft to "not found"; this one deliberately does not.
 */

import { describe, expect, it } from 'vitest';
import { gatherAlignmentDns, observeTxt, type AlignmentDnsDeps } from '../alignmentPreflightGather';
import type { AlignmentTarget } from '../alignmentPreflight';

function failing(code: string): AlignmentDnsDeps {
	return {
		resolveTxt: () => {
			const error: Error & { code?: string } = new Error(code);
			error.code = code;
			return Promise.reject(error);
		},
	};
}

describe('observeTxt failure mapping', () => {
	it('joins RFC 1035 multi-string chunks into one record', async () => {
		const observation = await observeTxt('acme.com', {
			resolveTxt: () => Promise.resolve([['v=spf1 ip4:203.0.113.10 ', '~all']]),
		});
		expect(observation).toEqual({
			state: 'found',
			records: ['v=spf1 ip4:203.0.113.10 ~all'],
		});
	});

	it('treats an authoritative no-such-record as ABSENT', async () => {
		for (const code of ['ENOTFOUND', 'ENODATA', 'NXDOMAIN']) {
			expect(await observeTxt('acme.com', failing(code))).toEqual({ state: 'absent' });
		}
	});

	it('treats an empty answer as ABSENT', async () => {
		expect(await observeTxt('acme.com', { resolveTxt: () => Promise.resolve([]) })).toEqual({
			state: 'absent',
		});
	});

	it('treats a timeout, SERVFAIL and REFUSED as UNKNOWN, never absent and never found', async () => {
		expect(await observeTxt('acme.com', failing('ETIMEOUT'))).toEqual({
			state: 'unknown',
			failure: 'timeout',
		});
		expect(await observeTxt('acme.com', failing('ETIMEDOUT'))).toEqual({
			state: 'unknown',
			failure: 'timeout',
		});
		expect(await observeTxt('acme.com', failing('ESERVFAIL'))).toEqual({
			state: 'unknown',
			failure: 'servfail',
		});
		expect(await observeTxt('acme.com', failing('EREFUSED'))).toEqual({
			state: 'unknown',
			failure: 'refused',
		});
	});

	it('treats a lookup that never settles as UNKNOWN once the deadline fires', async () => {
		// A slow-drip nameserver must not be able to burn the sweep's action budget:
		// the bound is ours, and the verdict it produces is a HOLD, not a fail.
		const observation = await observeTxt(
			'acme.com',
			{ resolveTxt: () => new Promise(() => {}) },
			5
		);
		expect(observation).toEqual({ state: 'unknown', failure: 'timeout' });
	});

	it('treats an unrecognised or code-less failure as UNKNOWN, not as absent', async () => {
		expect(await observeTxt('acme.com', failing('EBADSOMETHING'))).toEqual({
			state: 'unknown',
			failure: 'error',
		});
		expect(
			await observeTxt('acme.com', { resolveTxt: () => Promise.reject(new Error('boom')) })
		).toEqual({ state: 'unknown', failure: 'error' });
	});
});

describe('gatherAlignmentDns', () => {
	const target: AlignmentTarget = {
		organizationId: 'org-a',
		domain: 'acme.com',
		ownArm: {
			label: 'own MTA',
			fromDomain: 'ACME.com.',
			dkimDomain: 'acme.com',
			dkimSelectors: ['Owlat'],
			spfMechanisms: ['ip4:203.0.113.10'],
		},
		reference: {
			kind: 'arm',
			arm: {
				label: 'SES relay',
				fromDomain: 'acme.com',
				dkimDomain: 'acme.com',
				dkimSelectors: ['ses-token-1'],
				spfMechanisms: ['include:amazonses.com'],
				supportsCustomReturnPath: true,
			},
		},
	};

	it('queries the normalised names once each and keys DKIM by its full name', async () => {
		const queried: string[] = [];
		const facts = await gatherAlignmentDns(target, {
			resolveTxt: (name) => {
				queried.push(name);
				return Promise.resolve([['v=spf1 ~all']]);
			},
		});
		expect(queried).toEqual([
			'acme.com',
			'_dmarc.acme.com',
			'owlat._domainkey.acme.com',
			'ses-token-1._domainkey.acme.com',
		]);
		expect(Object.keys(facts.dkimTxt).sort()).toEqual([
			'owlat._domainkey.acme.com',
			'ses-token-1._domainkey.acme.com',
		]);
	});

	it('does not look up a second arm that does not exist', async () => {
		const queried: string[] = [];
		await gatherAlignmentDns(
			{ ...target, reference: { kind: 'none' } },
			{
				resolveTxt: (name) => {
					queried.push(name);
					return Promise.resolve([['v=spf1 ~all']]);
				},
			}
		);
		expect(queried).toEqual(['acme.com', '_dmarc.acme.com', 'owlat._domainkey.acme.com']);
	});
});
