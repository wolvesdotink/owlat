/**
 * Sending-domain provider registry.
 *
 * PLAN NUMBERS IN THIS FILE ARE THE MANDRILL PLAN'S (`D6` = kill the 'ses'-only
 * gates, `D7` = one generic relay-identity table + this registry; `P3.1` = the
 * Mandrill domain-identity adapter). The seams plan that owns the branch
 * numbers those differently — its D6 is the webhook registry and its D7 is the
 * `@owlat/mta-protocol` package — so the qualification is written out once here
 * rather than left to the reader. This work is the seams plan's P0.3, and its
 * `domainVerification` field is adopted by that plan's D1.
 *
 * The registry is what turned the two hard-coded relay gates into capability
 * lookups: routing asks the CATALOG whether a kind may relay (Mandrill D6), and
 * the relay-verification seam asks THIS registry whether the kind can prove a
 * domain. Both halves have to stay in agreement, and the agreement is enforced
 * at compile time — so these tests pin the runtime half (lookup + guard) and
 * the type-level half is asserted structurally, in a way that fails the build
 * rather than this file if it ever breaks.
 */

import { describe, expect, it } from 'vitest';
import {
	OWN_SENDING_DOMAIN_PROVIDER_KIND,
	SENDING_DOMAIN_PROVIDERS,
	isSendingDomainProviderKind,
	providerFor,
	type RelayProvingProviderModule,
	type SendingDomainProviderKind,
} from '../index';
import { OWN_ARM_TRANSPORT_KIND } from '../../../lib/sendProviders/strategies';
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

	it('names our own infrastructure with the same string the send arms do', () => {
		// D3 sanctions ONE identity check — own infrastructure vs. everything else
		// — and this pins that the two type domains spell it identically.
		// `providerRoutes.setRoute` demands an enabled arm of
		// `OWN_ARM_TRANSPORT_KIND` while the relay-identity drain three functions
		// above it filters domains on `OWN_SENDING_DOMAIN_PROVIDER_KIND`; if those
		// ever named different transports the route would still save and the drain
		// would match zero domains, leaving every pre-existing domain without the
		// relay identity its fallback later refuses to relay without.
		//
		// The build-time twin (`_OwnInfrastructureKindsAgree` in `../index.ts`) is
		// the real enforcement, and it fails the whole typecheck rather than this
		// file. This line is here so the failure is also legible as a test.
		expect(OWN_SENDING_DOMAIN_PROVIDER_KIND).toBe(OWN_ARM_TRANSPORT_KIND);
		expect(SENDING_DOMAIN_PROVIDERS[OWN_SENDING_DOMAIN_PROVIDER_KIND]).toBe(
			SENDING_DOMAIN_PROVIDERS.mta
		);
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

	it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
		'providerFor refuses the inherited member %s rather than returning it',
		(inherited) => {
			// `providerType` reaches the lookup as a plain string, and every object
			// literal inherits these. A truthiness check would hand `Object.prototype`
			// (or its constructor) back as if it were an adapter, and the caller would
			// fail one line later on `adapter.registerDomain is not a function` —
			// pointing at the lifecycle instead of at the unknown provider kind.
			expect(() => providerFor(inherited as SendingDomainProviderKind)).toThrow(
				/Unknown sending domain provider/
			);
		}
	);

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

describe('completeness against the send-provider catalog (Mandrill D6/D7)', () => {
	/**
	 * The runtime twin of the `_ApiVerifiedKindsHaveDomainProviders` mapped-type
	 * guard in `../index.ts`. That guard is the real enforcement — it fails the
	 * BUILD, naming the kind — but it only sees CORE kinds' literal types
	 * (`ApiVerifiedSendProviderKind` is an `Extract` over the core catalog
	 * literal), so this walks the whole composed catalog including anything a
	 * bundled plugin contributes. A bundled plugin transport whose generated
	 * entry declared `api` compiles clean through both type guards; this case is
	 * the only thing that catches it, so it asserts the PROPERTY per kind rather
	 * than short-circuiting on a hardcoded set — a plugin kind must fail here
	 * naming itself, not fail an equality against `['ses', 'mandrill']`.
	 */
	it('every kind declaring domainVerification: api has a registered provider', () => {
		const apiVerified = SEND_PROVIDER_CATALOG.filter(
			(entry) => domainVerificationFor(entry.kind) === 'api'
		).map((entry) => entry.kind);

		// Non-vacuity only — the exact core set is pinned by the case below.
		expect(apiVerified).toEqual(expect.arrayContaining(['ses', 'mandrill']));
		for (const kind of apiVerified) {
			expect({ kind, registered: isSendingDomainProviderKind(kind) }).toEqual({
				kind,
				registered: true,
			});
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

	/**
	 * ALL THREE relay seams are implemented IF AND ONLY IF the catalog declares
	 * `domainVerification: 'api'` for the kind — one table rather than one
	 * near-identical test per method, so the next optional per-kind seam is a
	 * row and a change to the rule is a single edit. This table is the ONLY
	 * runtime statement of that rule: the bespoke per-method cases it replaced
	 * (a "leaves the seams optional for `mta`" case and a
	 * `relayDomainVerified ⇒ describeReferenceArm` case) each restated a slice
	 * of it, so a change to the rule had to be made in three places or the suite
	 * disagreed with itself.
	 *
	 * Both directions matter, and the `iff` is what makes the second one an
	 * assertion. A provider may be registered implementing NONE of the three —
	 * our own MTA is, which is also why the methods cannot simply be required on
	 * the base interface: its domains are verified on the ordinary DNS path and
	 * it is never a fallback relay, so absence is an honest answer rather than a
	 * gap. Implementing one while declaring `none` is therefore a sign the
	 * catalog and the adapter disagree about what the kind is.
	 */
	const relayContractByCapability = [
		{
			method: 'relayDomainVerified',
			// The read half (Mandrill D6). A kind the catalog promises can prove a
			// domain, whose provider has no way to prove it, answers "unverified"
			// forever.
		},
		{
			method: 'ensureRelayIdentity',
			// The write half (P0.2). The drain in `providerRoutes.ts` no longer names
			// a kind: it asks whichever provider the route configured. A kind that
			// promises a proof but never provisions the identity that proof is read
			// from reports every pre-existing domain unverified — and its fallback
			// refuses to relay any of them, with the only symptom a runtime refusal
			// on a real send.
		},
		{
			method: 'describeReferenceArm',
			// The measurement half. The dual-transport alignment pre-flight asks the
			// registry for the second arm instead of testing `=== 'ses'`; a relay
			// that can prove a domain but cannot describe its arm resolves `unknown`
			// and holds the ramp at s=0 forever — silently, since nothing else in
			// the system notices.
		},
	] as const;

	it.each(relayContractByCapability)(
		'implements $method exactly when the catalog declares domainVerification: api',
		({ method }) => {
			for (const [kind, provider] of Object.entries(SENDING_DOMAIN_PROVIDERS)) {
				const declaresApi = domainVerificationFor(kind as SendProviderKind) === 'api';
				expect({ kind, implements: typeof provider[method] === 'function' }).toEqual({
					kind,
					implements: declaresApi,
				});
			}
		}
	);

	/**
	 * THE COMPILE-TIME HALF, pinned from both sides.
	 *
	 * `_relayProofTypecheck` in `../index.ts` is the enforcement: for exactly the
	 * kinds the catalog declares `domainVerification: 'api'`, the registered
	 * module must be a {@link RelayProvingProviderModule} — all three relay seams
	 * present. The runtime table above walks the modules we ship; these three
	 * cases walk the TYPE, so a loosening that no shipped adapter happens to
	 * exercise still fails.
	 *
	 * Each `@ts-expect-error` is itself the assertion: TypeScript reports an
	 * UNUSED `@ts-expect-error` as an error of its own, so if the requirement is
	 * ever weakened back to optional these lines fail `bun run typecheck` — the
	 * one gate that sees them, since vitest does not typecheck. The runtime
	 * `expect` below each keeps the value honest (and the linter quiet).
	 */
	it('will not let an api-verified module drop the enqueue-path proof', () => {
		const withoutProof: Omit<
			RelayProvingProviderModule<'ses'>,
			'relayDomainVerified'
		> = SENDING_DOMAIN_PROVIDERS.ses;
		// @ts-expect-error — a kind whose catalog entry promises a proof may not
		// omit the method that answers it: every domain would report unverified.
		const pinned: RelayProvingProviderModule<'ses'> = withoutProof;
		expect(pinned).toBe(SENDING_DOMAIN_PROVIDERS.ses);
	});

	it('will not let an api-verified module drop the identity backfill', () => {
		const withoutBackfill: Omit<
			RelayProvingProviderModule<'ses'>,
			'ensureRelayIdentity'
		> = SENDING_DOMAIN_PROVIDERS.ses;
		// @ts-expect-error — without the write half the proof above has nothing to
		// read, so every pre-existing domain stays unrelayable.
		const pinned: RelayProvingProviderModule<'ses'> = withoutBackfill;
		expect(pinned).toBe(SENDING_DOMAIN_PROVIDERS.ses);
	});

	it('will not let an api-verified module drop its reference-arm description', () => {
		const withoutArm: Omit<
			RelayProvingProviderModule<'ses'>,
			'describeReferenceArm'
		> = SENDING_DOMAIN_PROVIDERS.ses;
		// @ts-expect-error — the alignment pre-flight would resolve `unknown` and
		// hold the ramp at s=0, silently.
		const pinned: RelayProvingProviderModule<'ses'> = withoutArm;
		expect(pinned).toBe(SENDING_DOMAIN_PROVIDERS.ses);
	});
});
