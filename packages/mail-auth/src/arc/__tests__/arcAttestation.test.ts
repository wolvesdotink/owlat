/** Regression coverage for the trust-bearing sealed-AAR alignment fallback. */

import { describe, expect, it } from 'vitest';
import { aarAttestsPass } from '../attestation.js';
import type { HeaderField } from '../../dkim/message.js';

function aar(value: string): HeaderField {
	return { name: 'arc-authentication-results', raw: `ARC-Authentication-Results: ${value}` };
}

describe('aarAttestsPass — organizational-domain alignment', () => {
	it('accepts an aligned DKIM subdomain within one registrable domain', () => {
		expect(
			aarAttestsPass(
				aar(
					'i=1; relay.example; dmarc=none header.from=shop.example; dkim=pass header.d=mail.shop.example'
				)
			)
		).toBe(true);
	});

	it.each([
		{ suffix: 'co.uk', authenticated: 'attacker.co.uk', from: 'victim.co.uk' },
		{ suffix: 'github.io', authenticated: 'attacker.github.io', from: 'victim.github.io' },
		{ suffix: 'uk.com', authenticated: 'attacker.uk.com', from: 'victim.uk.com' },
	])('does not ARC-rescue DKIM across the $suffix suffix', ({ authenticated, from }) => {
		expect(
			aarAttestsPass(
				aar(
					`i=1; relay.example; dmarc=none header.from=${from}; dkim=pass header.d=${authenticated}`
				)
			)
		).toBe(false);
	});

	it('applies the same tenant boundary to the SPF fallback', () => {
		expect(
			aarAttestsPass(
				aar(
					'i=1; relay.example; dmarc=none header.from=victim.github.io; spf=pass smtp.mailfrom=attacker.github.io'
				)
			)
		).toBe(false);
	});
});
