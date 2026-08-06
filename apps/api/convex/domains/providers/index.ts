/**
 * Sending domain provider adapter (module) — registry + dispatch.
 *
 * PLAN NUMBERS IN THIS FILE ARE THE MANDRILL PLAN'S (`D6` = kill the 'ses'-only
 * gates, `D7` = one generic relay-identity table + this registry). The seams
 * plan that owns the branch numbers those differently — its D6 is the webhook
 * registry and its D7 is the `@owlat/mta-protocol` package — so the
 * qualification is written out once here rather than left to the reader. This
 * registry is the seams plan's P0.3.
 *
 * Adding a sending provider is a one-folder change:
 *   1. Create `convex/domains/providers/<kind>/index.ts` with the adapter.
 *   2. Add the kind and its identity payload to `SendingDomainIdentityRegistry`
 *      in `./types.ts`. Rows go in the generic, org-scoped
 *      `sendingDomainRelayIdentities` table (Mandrill D7) — the per-provider
 *      sibling pattern stopped at `sendingDomainMtaIdentities` /
 *      `sendingDomainSesIdentities`, which stay frozen and keep the MTA's and
 *      SES's rows.
 *   3. Add one entry to `SENDING_DOMAIN_PROVIDERS` below.
 *
 * The compile-time `satisfies` check on the registry catches missing methods.
 *
 * WHAT THAT ONE FOLDER DOES NOT YET COVER. Both relay-identity provisioning
 * paths now walk this registry (the seams plan's P0.4 routed the forward one
 * here), so a registered kind is reached end to end for identities. What
 * `domains/lifecycle.ts` still carries of its own is the RETURN-PATH family —
 * `setReturnPathHost` and its post-registration reconcile branch on
 * `providerType` to decide which bundle of `mailFrom` records to publish and
 * which reflection action to schedule, so a newly registered kind silently gets
 * neither. That is a separate capability from the identity seams below and it
 * has no home on this interface yet.
 *
 * Per ADR-0018, extended by Mandrill plan D6/D7.
 */

import { mandrillProvider } from './mandrill';
import { mtaProvider } from './mta';
import { sesProvider } from './ses';
import type { ApiVerifiedSendProviderKind } from '../../lib/sendProviders/catalog';
import type {
	RelayProvingProviderModule,
	SendingDomainProviderKind,
	SendingDomainProviderModule,
} from './types';

export type {
	SendingDomainProviderKind,
	SendingDomainIdentityRegistry,
	SendingDomainProviderModule,
	RelayProvingProviderModule,
	ProviderIdentity,
	ProviderIdentityFor,
	MtaIdentity,
	SesIdentity,
	MandrillIdentity,
	RelayIdentityStatus,
	ProviderCheckResult,
} from './types';

// Registry — keyed by `domains.providerType`. The lifecycle calls
// `providerFor(kind)` to get the adapter; no caller imports adapters directly.
//
// We use the `unknown` round-trip to satisfy TypeScript while keeping the
// generic parameter narrowed at the call site of `providerFor`.
export const SENDING_DOMAIN_PROVIDERS = {
	mta: mtaProvider,
	ses: sesProvider,
	mandrill: mandrillProvider,
} as const;

/**
 * OUR OWN INFRASTRUCTURE, in the domain-provider type domain — the one kind
 * whose sending domains we host ourselves, and therefore the one kind a relay
 * identity may COEXIST on (a domain already hosted at some provider owns its
 * identity through the ordinary lifecycle).
 *
 * D3 sanctions this identity check; it does not sanction restating it. Read
 * from the adapter's own `kind` so the value has exactly one declaration —
 * `domains/providers/mta/index.ts` — rather than a literal at each site that
 * asks the question. `OWN_ARM_TRANSPORT_KIND` (lib/sendProviders/strategies) is
 * the twin of this constant in the SEND-TRANSPORT type domain: same string,
 * different union, each declared once.
 */
export const OWN_SENDING_DOMAIN_PROVIDER_KIND = mtaProvider.kind;

/**
 * Compile-time pin: the two names for our own infrastructure are ONE STRING.
 *
 * They are separately derived — this one from `mtaProvider.kind`, its twin from
 * a literal in `strategies/adaptive_mix` — and that independence is the point
 * of the type-level assertion below rather than a comment. Without it, renaming
 * `mtaProvider.kind` (or introducing a second own-infrastructure kind) leaves
 * `setRoute` still accepting a fallback route while the relay-identity drain
 * beside it filters on the OTHER constant and matches zero domains: no relay
 * identity is written, every pre-existing domain then fails `relayDomainVerified`
 * and the fallback refuses to relay it, and the only symptom is a runtime
 * refusal on a real send.
 *
 * A `typeof import(...)` in type position, so nothing at runtime imports the
 * strategy barrel from the domain-provider registry — the constraint is paid
 * for entirely at build time. Asserted in BOTH directions: each literal type
 * must be assignable to the other, so widening either declaration fails here
 * too. Its runtime twin is one line in `./__tests__/registry.test.ts`.
 */
type OwnArmTransportKind =
	typeof import('../../lib/sendProviders/strategies/adaptive_mix').OWN_ARM_TRANSPORT_KIND;
type AssertOwnKindsAgree<
	_A extends OwnArmTransportKind,
	_B extends OwnSendingDomainProviderKind,
> = true;
type OwnSendingDomainProviderKind = typeof OWN_SENDING_DOMAIN_PROVIDER_KIND;
export type _OwnInfrastructureKindsAgree = AssertOwnKindsAgree<
	OwnSendingDomainProviderKind,
	OwnArmTransportKind
>;

// Compile-time guard: each registry value must satisfy the adapter shape for
// its own kind. The mapped type pins each key to `Module<thatKey>`, so a
// missing method (or a kind mismatch) is a compile error.
const _typecheck: { [K in SendingDomainProviderKind]: SendingDomainProviderModule<K> } =
	SENDING_DOMAIN_PROVIDERS;
void _typecheck;

/**
 * Compile-time completeness guard (Mandrill D6/D7): every send-transport kind whose
 * catalog entry declares `domainVerification: 'api'` MUST have a registered
 * domain-identity provider here.
 *
 * The catalog is a PROMISE — "this relay can prove a domain is verified" — and
 * the relay-verification seam reads that promise by asking this registry. A
 * kind that declares `api` with no provider would answer "unverified" for
 * every domain forever, so the deliverability fallback would refuse to relay
 * anything and the only symptom would be a runtime refusal on a real send.
 * This turns that into a build failure naming the missing kind.
 *
 * One-directional on purpose: a registered provider whose kind declares `none`
 * (our MTA, whose domains are verified on the ordinary DNS path and which is
 * never a relay) is entirely legitimate.
 *
 * CORE KINDS ONLY. `ApiVerifiedSendProviderKind` is an `Extract` over the CORE
 * catalog literal, and `domainVerification` is optional on the shared entry
 * interface precisely so generated plugin entries can omit it — so a bundled
 * plugin transport declaring `api` compiles clean through this guard and
 * through `_relayProofTypecheck` below. Runtime stays fail-closed
 * (`isSendingDomainProviderKind` rejects `plugin.<id>.<kind>`, so the seam
 * answers "unverifiable" rather than crediting a proof), and the one gate that
 * NOTICES is the catalog-walking case in `./__tests__/registry.test.ts`.
 * Closing it at the type level is the seams plan's P3.2 (plugin domain
 * identity).
 */
type ApiVerifiedKindMissingProvider = Exclude<
	ApiVerifiedSendProviderKind,
	SendingDomainProviderKind
>;
type AssertEveryApiVerifiedKindHasProvider<_T extends never> = true;
export type _ApiVerifiedKindsHaveDomainProviders =
	AssertEveryApiVerifiedKindHasProvider<ApiVerifiedKindMissingProvider>;

/**
 * The second half of the same promise: a registered provider for an `api` kind
 * must actually IMPLEMENT the relay seams, not merely occupy the key.
 *
 * The guard above proves the kind is in this registry. It cannot prove the
 * adapter answers anything — `relayDomainVerified`, `ensureRelayIdentity` and
 * `describeReferenceArm` are optional on the module interface, because absence
 * is the honest answer for a `domainVerification: 'none'` kind (our own MTA is
 * registered here and implements none of the three). So a new `api` kind could
 * register an adapter with an empty relay surface, compile green, and fail
 * silently in the three ways {@link RelayProvingProviderModule} spells out.
 *
 * This mapped type closes that: for exactly the kinds the CATALOG declares
 * `api`, the registered module must be relay-proving. Intersecting with
 * `SendingDomainProviderKind` is not a weakening — an `api` kind that is not
 * registered at all is already the guard above, which names it more directly
 * than a missing-property error would.
 *
 * Runtime twin: the capability table in `./__tests__/registry.test.ts`, which
 * also walks bundled plugin kinds the literal types above cannot see.
 */
type RelayProvingKind = ApiVerifiedSendProviderKind & SendingDomainProviderKind;
const _relayProofTypecheck: { [K in RelayProvingKind]: RelayProvingProviderModule<K> } =
	SENDING_DOMAIN_PROVIDERS;
void _relayProofTypecheck;

/**
 * Look up the adapter for a provider kind. Throws on unknown kinds —
 * `domains.providerType` is validated as a literal union before this is
 * called, so a throw here means a data-integrity bug (or a brand-new provider
 * landed without a registry entry).
 *
 * REGISTRATION IS `hasOwnProperty`, not truthiness, for the same reason
 * {@link isSendingDomainProviderKind} below spells it that way: `providerType`
 * reaches us as a plain string (the schema keeps it `v.optional(v.string())`
 * for forward-compat), and a string like `constructor` or `__proto__` finds an
 * INHERITED member on any object literal. A truthiness check hands that
 * inherited value back as if it were an adapter, and the caller then fails on
 * `adapter.registerDomain is not a function` — a confusing error, one call
 * later, instead of the accurate one here.
 */
export function providerFor<K extends SendingDomainProviderKind>(
	kind: K
): SendingDomainProviderModule<K> {
	if (!Object.prototype.hasOwnProperty.call(SENDING_DOMAIN_PROVIDERS, kind)) {
		throw new Error(`Unknown sending domain provider: ${kind}`);
	}
	return SENDING_DOMAIN_PROVIDERS[kind] as unknown as SendingDomainProviderModule<K>;
}

/**
 * Type guard: is the given string a recognized provider kind? Useful when
 * narrowing `domains.providerType` (typed as `v.optional(v.string())` in
 * the schema for forward-compat) before dispatching.
 *
 * Answers from the REGISTRY rather than from a restated literal list, so a
 * newly registered provider is recognized by the guard the moment it is
 * registered — a hand-maintained twin of the registry keys is how a kind ends
 * up dispatchable but unrecognized (or the reverse).
 */
export function isSendingDomainProviderKind(
	kind: string | undefined | null
): kind is SendingDomainProviderKind {
	return (
		typeof kind === 'string' && Object.prototype.hasOwnProperty.call(SENDING_DOMAIN_PROVIDERS, kind)
	);
}
