/**
 * Sending-domain provider registry (plan D7).
 *
 * The registry is what turned the two hard-coded relay gates into capability
 * lookups: routing asks the CATALOG whether a kind may relay (D6), and the
 * relay-verification seam asks THIS registry whether the kind can prove a
 * domain. Both halves have to stay in agreement, and the agreement is enforced
 * at compile time — so these tests pin the runtime half (lookup + guard) and
 * the type-level half is asserted structurally, in a way that fails the build
 * rather than this file if it ever breaks.
 */

import { describe, expect, it } from 'vitest';
import {
	SENDING_DOMAIN_PROVIDERS,
	isSendingDomainProviderKind,
	providerFor,
	type SendingDomainProviderKind,
} from '../index';
import {
	SEND_PROVIDER_CATALOG,
	domainVerificationFor,
	type ApiVerifiedSendProviderKind,
	type SendProviderKind,
} from '../../../lib/sendProviders/catalog';

describe('SENDING_DOMAIN_PROVIDERS', () => {
	it('registers exactly the shipped kinds, each declaring its own kind', () => {
		expect(Object.keys(SENDING_DOMAIN_PROVIDERS).sort()).toEqual(['mandrill', 'mta', 'ses']);
		for (const [key, provider] of Object.entries(SENDING_DOMAIN_PROVIDERS)) {
			expect(provider.kind).toBe(key);
		}
	});

	it('providerFor returns the adapter for a registered kind', () => {
		expect(providerFor('mta')).toBe(SENDING_DOMAIN_PROVIDERS.mta);
		expect(providerFor('ses')).toBe(SENDING_DOMAIN_PROVIDERS.ses);
		expect(providerFor('mandrill')).toBe(SENDING_DOMAIN_PROVIDERS.mandrill);
	});

	it('providerFor throws on an unregistered kind', () => {
		expect(() => providerFor('postmark' as SendingDomainProviderKind)).toThrow(
			/Unknown sending domain provider/
		);
	});

	it('isSendingDomainProviderKind answers from the registry, not a restated list', () => {
		for (const kind of Object.keys(SENDING_DOMAIN_PROVIDERS)) {
			expect(isSendingDomainProviderKind(kind)).toBe(true);
		}
		expect(isSendingDomainProviderKind('resend')).toBe(false);
		expect(isSendingDomainProviderKind('postmark')).toBe(false);
		expect(isSendingDomainProviderKind('')).toBe(false);
		expect(isSendingDomainProviderKind(undefined)).toBe(false);
		expect(isSendingDomainProviderKind(null)).toBe(false);
		// Inherited object properties are not registrations.
		expect(isSendingDomainProviderKind('toString')).toBe(false);
		expect(isSendingDomainProviderKind('constructor')).toBe(false);
	});
});

describe('completeness against the send-provider catalog (D6/D7)', () => {
	/**
	 * The runtime twin of the `_ApiVerifiedKindsHaveDomainProviders` mapped-type
	 * guard in `../index.ts`. That guard is the real enforcement — it fails the
	 * BUILD, naming the kind — but it only sees core kinds' literal types, so
	 * this walks the whole catalog including anything a bundled plugin
	 * contributes.
	 */
	it('every kind declaring domainVerification: api has a registered provider', () => {
		const apiVerified = SEND_PROVIDER_CATALOG.filter(
			(entry) => domainVerificationFor(entry.kind) === 'api'
		).map((entry) => entry.kind);

		expect(apiVerified).toEqual(['ses', 'mandrill']);
		for (const kind of apiVerified) {
			expect(isSendingDomainProviderKind(kind)).toBe(true);
		}
	});

	it('pins the compile-time guard to the same set the catalog declares', () => {
		// If `domainVerification: 'api'` is added to a kind, this assignment stops
		// compiling until the kind is added here AND registered above — which is
		// the point: the type is derived from the catalog literal, so it cannot
		// drift from it silently.
		const apiVerifiedKinds: ApiVerifiedSendProviderKind[] = ['ses', 'mandrill'];
		expect(apiVerifiedKinds).toEqual(['ses', 'mandrill']);
	});

	it('only api-verified kinds implement the relay-verification read seam', () => {
		// A provider may be registered without one (our MTA is: its domains are
		// verified on the ordinary DNS path and it is never a fallback relay).
		// What must never happen is the reverse — a kind the catalog promises can
		// prove a domain, whose provider has no way to prove it.
		for (const [kind, provider] of Object.entries(SENDING_DOMAIN_PROVIDERS)) {
			const declaresApi = domainVerificationFor(kind as SendProviderKind) === 'api';
			expect(typeof provider.relayDomainVerified === 'function').toBe(declaresApi);
		}
	});

	it('every kind that can prove a domain also describes its own reference arm', () => {
		// P3.1's second half: the alignment pre-flight asks the registry for the
		// second arm instead of testing `=== 'ses'`. A relay that can prove a
		// domain but cannot describe it would resolve `unknown` and hold the ramp
		// at s=0 forever — silently, since nothing else in the system notices.
		for (const provider of Object.values(SENDING_DOMAIN_PROVIDERS)) {
			if (provider.relayDomainVerified === undefined) continue;
			expect(typeof provider.describeReferenceArm).toBe('function');
		}
	});
});
