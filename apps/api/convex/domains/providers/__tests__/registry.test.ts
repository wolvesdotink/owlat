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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
	OWN_SENDING_DOMAIN_PROVIDER_KIND,
	SENDING_DOMAIN_PROVIDERS,
	isSendingDomainProviderKind,
	providerFor,
	relayIdentityProviderFor,
	type RelayProvingProviderModule,
	type SendingDomainProviderKind,
	type SendingDomainProviderModule,
} from '../index';
import { toRelayIdentityProvider } from '../relaySurface';
import { OWN_ARM_TRANSPORT_KIND } from '../../../lib/sendProviders/strategies';
import {
	SEND_PROVIDER_CATALOG,
	domainVerificationFor,
	isCoreSendProviderKind,
	type ApiVerifiedSendProviderKind,
	type SendProviderKind,
} from '../../../lib/sendProviders/catalog';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const readSource = (relativePath: string): string =>
	readFileSync(resolve(sourceDir, relativePath), 'utf8');

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

	it('names the forward-provisioning effect exactly while it is a hand-written list', () => {
		// `../index.ts` may warn that registering an adapter does not by itself put
		// a kind on the FORWARD relay-provisioning path only while
		// `provision_relay_identity_if_enabled` schedules from a hand-written list
		// of relay kinds. Pinned in BOTH directions — the same treatment
		// `apps/docs/__tests__/abstractionsDocs.test.ts` gives the abstraction
		// page's copy of the warning. The effect is a registry walk today, so a
		// surviving warning would tell the next author their kind is unreachable on
		// the forward path when it is not; and if the walk is ever unwound back
		// into a list, the warning has to come back. Nothing else in the tree would
		// notice either direction.
		const stillAHandWrittenList =
			readSource('../../lifecycle.ts').includes("relayKinds.has('ses')");
		expect(readSource('../index.ts').includes('provision_relay_identity_if_enabled')).toBe(
			stillAHandWrittenList
		);
	});
});

describe('completeness against the send-provider catalog (Mandrill D6/D7)', () => {
	/**
	 * The runtime twin of the `_ApiVerifiedKindsHaveDomainProviders` mapped-type
	 * guard in `../index.ts`. That guard is the real enforcement — it fails the
	 * BUILD, naming the kind — but it only sees CORE kinds' literal types
	 * (`ApiVerifiedSendProviderKind` is an `Extract` over the core catalog
	 * literal), so this walks the whole composed catalog including anything a
	 * bundled plugin contributes. It asserts the PROPERTY per kind rather than
	 * short-circuiting on a hardcoded set: a kind with no provider must fail here
	 * naming itself, not fail an equality against `['ses', 'mandrill']`.
	 *
	 * THE REGISTRATION IT ASKS ABOUT IS THE RELAY ONE (the seams plan's P3.2), and
	 * that is a widening of this case rather than a weakening. `domainVerification`
	 * promises a relay can PROVE a domain, which is
	 * {@link relayIdentityProviderFor} — the composed registry, holding every core
	 * adapter that implements the three relay seams plus every bundled plugin
	 * transport that contributed a `domainIdentity`. It answers identically to
	 * `isSendingDomainProviderKind` for `ses` and `mandrill`, and unlike it, it
	 * gives a plugin kind the answer the promise actually refers to: the primary
	 * guard governs `domains.providerType`, which stays closed to the core union
	 * on purpose.
	 */
	it('every kind declaring domainVerification: api has a registered provider', () => {
		const apiVerified = SEND_PROVIDER_CATALOG.filter(
			(entry) => domainVerificationFor(entry.kind) === 'api'
		).map((entry) => entry.kind);

		// Both readings, in the same case. The COMPOSED catalog is asserted as a
		// superset on purpose: a bundled plugin kind declaring `api` legitimately
		// widens it and must reach the per-kind loop below, naming itself, rather
		// than fail an equality here.
		expect(apiVerified).toEqual(expect.arrayContaining(['ses', 'mandrill']));
		// The CORE half keeps its exact pin at RUNTIME as well as at the type
		// level. `_ApiVerifiedCoreSetIsExactly_Ses_Mandrill` at the bottom of this
		// file is the same statement, but only `bun run typecheck` sees it —
		// vitest does not typecheck — so without this line a third core kind
		// declaring `domainVerification: 'api'` leaves `npx vitest run` fully
		// green, silently accepted by the suite whose stated job is to make the
		// core set explicit. The widening above was for the plugin tier; the core
		// tier did not need to lose anything for it.
		expect(apiVerified.filter(isCoreSendProviderKind)).toEqual(['ses', 'mandrill']);
		for (const kind of apiVerified) {
			expect({ kind, registered: relayIdentityProviderFor(kind) !== undefined }).toEqual({
				kind,
				registered: true,
			});
		}
	});

	/**
	 * The exact core api-verified set — the lower half of a two-sided pin. This
	 * assignment proves `'ses' | 'mandrill'` is CONTAINED in
	 * `ApiVerifiedSendProviderKind`; the complement (nothing else is in it) is
	 * `_ApiVerifiedCoreSetIsExactly_Ses_Mandrill` at the bottom of this file,
	 * where a type alias is legal. Containment alone would not be a pin: a third
	 * core kind declaring `domainVerification: 'api'` widens the derived type and
	 * this line still compiles.
	 */
	it('pins the compile-time guard to the same set the catalog declares', () => {
		// If `domainVerification: 'api'` is added to a kind, this assignment stops
		// compiling until the kind is added here AND registered above — which is
		// the point: the type is derived from the catalog literal, so it cannot
		// drift from it silently.
		const apiVerifiedKinds: ApiVerifiedSendProviderKind[] = ['ses', 'mandrill'];
		expect(apiVerifiedKinds).toEqual(['ses', 'mandrill']);
	});

	// The other direction of the same pin lives at the bottom of this file
	// (`_ApiVerifiedCoreSetIsExactly_Ses_Mandrill`), where a type alias is legal.

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
	 * THE ALL-OR-NOTHING RULE FOR THE THREE SEAMS, at the seam that enforces it.
	 *
	 * Core membership of the relay-identity registry is STRUCTURAL — an adapter
	 * joins iff it implements all three — which quietly narrows what a partial
	 * adapter can reach: before the registry, each caller asked its own question
	 * (`relayIdentityBackfills` needed only `ensureRelayIdentity`). The type-level
	 * guard does not close that gap, because `RelayProvingProviderModule` is only
	 * required for kinds whose catalog entry says `domainVerification: 'api'`; a
	 * kind declaring `none` that implemented one seam would compile clean and then
	 * silently never be backfilled, surfacing as a relay refusing From domains once
	 * the deliverability fallback opened.
	 *
	 * So the composition REFUSES it instead of dropping it. These cases are why
	 * `toRelayIdentityProvider` is its own function: the failing shape cannot be
	 * constructed through the module-scope registry at all.
	 */
	describe('toRelayIdentityProvider', () => {
		const seam = async (): Promise<never> => {
			throw new Error('not called');
		};
		const base = {
			kind: 'mta',
		} as unknown as SendingDomainProviderModule<SendingDomainProviderKind>;

		it('answers null for an adapter that implements none of the three', () => {
			// Our own MTA: never a fallback relay, verified on the ordinary DNS path.
			// Absence is an honest answer, not a gap.
			expect(toRelayIdentityProvider('mta', base)).toBeNull();
			expect(relayIdentityProviderFor('mta')).toBeUndefined();
		});

		it.each([['relayDomainVerified'], ['describeReferenceArm'], ['ensureRelayIdentity']] as const)(
			'refuses an adapter that implements only %s',
			(method) => {
				const partial = {
					...base,
					[method]: seam,
				} as SendingDomainProviderModule<SendingDomainProviderKind>;
				// Naming the kind AND the count: the message is read by whoever added the
				// adapter, at deploy time, with no other signal that anything is wrong.
				expect(() => toRelayIdentityProvider('mta', partial)).toThrow(
					/'mta' implements 1 of the three relay seams/
				);
			}
		);

		it('carries the optional sweep arm only for the kinds that declare it', () => {
			// A fourth, separately optional seam, and the distinction is real: it says
			// "this kind keeps its rows in the shared table", which SES proves domains
			// without doing (its identities live in the frozen sibling).
			expect(typeof relayIdentityProviderFor('mandrill')?.scheduleRelayIdentityRefresh).toBe(
				'function'
			);
			expect(relayIdentityProviderFor('ses')?.scheduleRelayIdentityRefresh).toBeUndefined();
		});
	});

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

/**
 * The upper half of the api-verified set pin, and the reason the case
 * `pins the compile-time guard to the same set the catalog declares` can call
 * itself exact rather than merely non-vacuous.
 *
 * That case's assignment proves `'ses' | 'mandrill'` is CONTAINED in
 * `ApiVerifiedSendProviderKind`; on its own it survives a third core kind
 * declaring `domainVerification: 'api'` without a word. `Exclude` here is the
 * complement, and `AssertNoOtherApiVerifiedKind` accepts only `never` — so the
 * third kind fails `bun run typecheck` (the one gate that sees this file;
 * vitest does not typecheck), naming itself, until it is added to that literal.
 *
 * Nothing UNSAFE follows from a widened set — a missing adapter is caught by
 * `_ApiVerifiedKindsHaveDomainProviders` and a hollow one by
 * `_relayProofTypecheck`, both in `../index.ts`. What this buys is that the new
 * kind is ACKNOWLEDGED: the literal above is where a human states the core set,
 * and the runtime table above walks it.
 */
type AssertNoOtherApiVerifiedKind<_T extends never> = true;
export type _ApiVerifiedCoreSetIsExactly_Ses_Mandrill = AssertNoOtherApiVerifiedKind<
	Exclude<ApiVerifiedSendProviderKind, 'ses' | 'mandrill'>
>;
