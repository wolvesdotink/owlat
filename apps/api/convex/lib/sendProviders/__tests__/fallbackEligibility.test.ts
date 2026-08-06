/**
 * Capability-driven deliverability-fallback eligibility (plan D6).
 *
 * The gate this replaced was `relayProviderType !== 'ses' → throw`: a list of
 * one, which every future relay had to edit routing logic to join. These tests
 * pin the two properties that swap has to preserve and the one it has to
 * change:
 *
 *   - SES behaves EXACTLY as before (the shipped relay must not notice);
 *   - an unconfigured kind still fails closed, with the same error code;
 *   - a CONFIGURED non-SES kind now passes, with no edit to `routing.ts`.
 *
 * P0.2 adds the half a capability gate is not finished without: what the
 * REFUSAL says. A gate that admits every kind but explains itself by naming one
 * of them still sends the operator of a Resend/SMTP/Mandrill route off to
 * configure Amazon SES, so the copy is pinned here against the catalog rather
 * than against a remembered string.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { isFallbackRelayEligible } from '../fallbackEligibility';
import { providerKindConfigured } from '../capability';
import { SEND_PROVIDER_CATALOG } from '../catalog';
import { DeliverabilityRouteError, resolveRoute, type ProviderRouteConfig } from '../routing';
import type { SendProviderKind } from '../types';

/** Every kind is configured — the "credentials are not the question" probe. */
const allConfigured = () => true;

/** A route whose fallback relay is `relay`, with the owned MTA as the primary. */
function hybridRoute(relay: string): ProviderRouteConfig {
	return {
		strategy: 'single',
		providers: [
			{ providerType: 'mta', isEnabled: true },
			{ providerType: relay, isEnabled: true },
		],
		deliverabilityFallback: {
			isEnabled: true,
			relayProviderType: relay,
			isWarmupOverflowEnabled: false,
		},
	};
}

/** Resolve `route` with an active fallback reason and a verified relay domain. */
function resolveWithActiveFallback(
	route: ProviderRouteConfig,
	isReady: (kind: SendProviderKind) => boolean = allConfigured
) {
	return resolveRoute(route, undefined, isReady, {
		activeReasons: ['breaker_open'],
		isWarmupOverflow: false,
		isRelayDomainVerified: true,
	});
}

describe('isFallbackRelayEligible', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('accepts every catalog kind except the owned MTA when configured', () => {
		expect(isFallbackRelayEligible('ses', allConfigured)).toBe(true);
		expect(isFallbackRelayEligible('resend', allConfigured)).toBe(true);
		expect(isFallbackRelayEligible('smtp', allConfigured)).toBe(true);
		// P1.1 registered `mandrill`, and it became fallback-eligible without a line
		// of routing code changing — which is the whole claim of D6. It is also the
		// activation matrix's recommended migration shape: `deliverabilityFallback:
		// { relayProviderType: 'mandrill' }`.
		expect(isFallbackRelayEligible('mandrill', allConfigured)).toBe(true);
	});

	it('rejects the owned MTA even when it is configured', () => {
		// The MTA is the arm a fallback moves traffic AWAY from. Relaying to it
		// would "relieve" a reputation problem through the transport that has it,
		// so this rejection is a rule, not a configuration accident.
		expect(isFallbackRelayEligible('mta', allConfigured)).toBe(false);
	});

	it('rejects kinds the catalog does not know, and nullish input', () => {
		expect(isFallbackRelayEligible('postmark', allConfigured)).toBe(false);
		expect(isFallbackRelayEligible('sendgrid', allConfigured)).toBe(false);
		expect(isFallbackRelayEligible('', allConfigured)).toBe(false);
		expect(isFallbackRelayEligible(undefined, allConfigured)).toBe(false);
		expect(isFallbackRelayEligible(null, allConfigured)).toBe(false);
	});

	it('fails closed on an unconfigured kind, against the real env source', () => {
		// `providerKindConfigured` is the deployment's env-only credential source.
		// Nothing stubs the SES or Resend variables here, so both are genuinely
		// unconfigured and eligibility must say so.
		expect(isFallbackRelayEligible('ses', providerKindConfigured)).toBe(false);
		expect(isFallbackRelayEligible('resend', providerKindConfigured)).toBe(false);

		vi.stubEnv('RESEND_API_KEY', 're_test_key');
		expect(isFallbackRelayEligible('resend', providerKindConfigured)).toBe(true);
		// …and configuring one relay says nothing about another.
		expect(isFallbackRelayEligible('ses', providerKindConfigured)).toBe(false);
	});
});

describe('DeliverabilityRouteError — kind-agnostic copy (D2)', () => {
	/**
	 * Tokenize on word boundaries rather than substrings, so "unverified" is not
	 * read as naming `resend` and a namespaced plugin kind (`plugin.acme.esp`)
	 * survives as one token — hence `.` inside the token but STRIPPED at its
	 * edges. Without that trim, "…enable the relay for ses." tokenizes as `ses.`
	 * and a kind at the end of a clause would walk straight past this guard.
	 */
	function wordsOf(message: string): Set<string> {
		return new Set(
			message
				.toLowerCase()
				.split(/[^a-z0-9.]+/)
				.map((token) => token.replace(/^\.+|\.+$/g, ''))
				.filter(Boolean)
		);
	}

	it('tokenizes clause-final and namespaced kinds the way the guard below needs', () => {
		// The guard is only as good as this: a self-test, because a tokenizer that
		// silently stopped seeing kinds would make every assertion below vacuous.
		const words = wordsOf('Configure the relay for ses. Or plugin.acme.esp, or resend!');
		expect(words.has('ses')).toBe(true);
		expect(words.has('plugin.acme.esp')).toBe(true);
		expect(words.has('resend')).toBe(true);
		// Substrings are not matches: "unverified" must not read as `resend`.
		expect(wordsOf('unverified').has('resend')).toBe(false);
	});

	it('names no provider in either refusal', () => {
		// The `unavailable` message used to read "enable the verified Amazon SES
		// transport" — true only while the gate above it WAS `!== 'ses'`. Asserted
		// against the catalog rather than against a literal, so the day a sixth
		// kind lands its label cannot be pasted into this copy either.
		for (const reason of ['unverified', 'unavailable'] as const) {
			const { message } = new DeliverabilityRouteError(reason);
			const words = wordsOf(message);
			for (const entry of SEND_PROVIDER_CATALOG) {
				expect(message).not.toContain(entry.label);
				expect(words.has(entry.kind)).toBe(false);
				// Belt and braces for the kinds whose names are also English words
				// or live at a clause boundary: the raw message, on word boundaries.
				expect(message.toLowerCase()).not.toMatch(
					new RegExp(`(^|[^a-z0-9.])${entry.kind.replace(/\./g, '\\.')}([^a-z0-9.]|$)`)
				);
			}
			// The vendor names behind the labels, spelled out: a future rewording
			// that says "Amazon" or "Mailchimp" without the exact label would slip
			// past the loop above. Only names that are NOT catalog kinds belong
			// here — the loop owns `mandrill` and `resend`, on word boundaries, and
			// substring-matching `resend` would fail an innocent "before resending".
			expect(message).not.toMatch(/amazon|mailchimp|postmark|sendgrid/i);
		}
	});

	it('still tells the operator what to do, and keeps the codes', () => {
		// Kind-agnostic must not mean contentless — the refusal is the only thing
		// an operator sees when a fallback stops relaying.
		const unavailable = new DeliverabilityRouteError('unavailable');
		expect(unavailable.message).toMatch(/relay/i);
		expect(unavailable.message).toMatch(/disable automatic fallback/i);
		expect(unavailable.code).toBe('DELIVERABILITY_RELAY_UNAVAILABLE');

		const unverified = new DeliverabilityRouteError('unverified');
		expect(unverified.message).toMatch(/verify this sending domain/i);
		expect(unverified.code).toBe('DELIVERABILITY_RELAY_DOMAIN_UNVERIFIED');
		// The default arm is the domain proof, unchanged.
		expect(new DeliverabilityRouteError().code).toBe('DELIVERABILITY_RELAY_DOMAIN_UNVERIFIED');
	});
});

describe('resolveRoute — deliverability fallback gate (D6)', () => {
	it('keeps routing an active fallback to a ready, verified SES relay', () => {
		expect(resolveWithActiveFallback(hybridRoute('ses'))).toEqual({
			providerType: 'ses',
			source: 'deliverability_fallback',
			deliverabilityReason: 'breaker_open',
		});
	});

	it('now routes an active fallback to a ready, verified NON-SES relay', () => {
		// The whole point of D6: this line used to throw
		// DELIVERABILITY_RELAY_UNAVAILABLE purely because the kind was not `ses`.
		expect(resolveWithActiveFallback(hybridRoute('resend'))).toEqual({
			providerType: 'resend',
			source: 'deliverability_fallback',
			deliverabilityReason: 'breaker_open',
		});
		expect(resolveWithActiveFallback(hybridRoute('smtp'))).toEqual({
			providerType: 'smtp',
			source: 'deliverability_fallback',
			deliverabilityReason: 'breaker_open',
		});
	});

	it('fails closed on an unconfigured relay, with the unchanged error code', () => {
		for (const relay of ['ses', 'resend']) {
			try {
				resolveWithActiveFallback(hybridRoute(relay), (kind) => kind === 'mta');
				expect.unreachable(`${relay} must not resolve while unconfigured`);
			} catch (error) {
				expect(error).toBeInstanceOf(DeliverabilityRouteError);
				expect((error as DeliverabilityRouteError).code).toBe('DELIVERABILITY_RELAY_UNAVAILABLE');
			}
		}
	});

	it('rejects an MTA-to-MTA fallback with the same taxonomy', () => {
		const selfRelay: ProviderRouteConfig = {
			strategy: 'single',
			providers: [{ providerType: 'mta', isEnabled: true }],
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType: 'mta',
				isWarmupOverflowEnabled: false,
			},
		};
		try {
			resolveWithActiveFallback(selfRelay);
			expect.unreachable('the owned MTA must never be its own fallback relay');
		} catch (error) {
			expect(error).toBeInstanceOf(DeliverabilityRouteError);
			expect((error as DeliverabilityRouteError).code).toBe('DELIVERABILITY_RELAY_UNAVAILABLE');
		}
	});

	it('rejects a retired or unknown relay kind', () => {
		try {
			resolveWithActiveFallback(hybridRoute('postmark'));
			expect.unreachable('an unknown relay kind must not resolve');
		} catch (error) {
			expect((error as DeliverabilityRouteError).code).toBe('DELIVERABILITY_RELAY_UNAVAILABLE');
		}
	});

	it('still demands a verified relay domain once the kind is eligible', () => {
		// Eligibility answers "may this kind relay at all", never "may it relay
		// THIS domain" — the proof gate (D7) stays in front of every kind.
		for (const relay of ['ses', 'resend']) {
			try {
				resolveRoute(hybridRoute(relay), undefined, allConfigured, {
					activeReasons: ['breaker_open'],
					isWarmupOverflow: false,
					isRelayDomainVerified: false,
				});
				expect.unreachable(`${relay} must not relay an unverified domain`);
			} catch (error) {
				expect((error as DeliverabilityRouteError).code).toBe(
					'DELIVERABILITY_RELAY_DOMAIN_UNVERIFIED'
				);
			}
		}
	});

	it('leaves normal selection untouched when no fallback reason is active', () => {
		expect(
			resolveRoute(hybridRoute('resend'), undefined, allConfigured, {
				activeReasons: [],
				isWarmupOverflow: false,
				isRelayDomainVerified: true,
			})
		).toMatchObject({ providerType: 'mta', source: 'org_config' });
	});
});
