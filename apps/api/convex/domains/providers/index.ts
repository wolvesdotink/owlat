/**
 * Sending domain provider adapter (module) — registry + dispatch.
 *
 * Adding a third sending provider is a one-folder change:
 *   1. Create `convex/domains/providers/<kind>/index.ts` with the adapter.
 *   2. Add the kind and its identity payload to `SendingDomainIdentityRegistry`
 *      in `./types.ts`. Rows go in the generic, org-scoped
 *      `sendingDomainRelayIdentities` table (D7) — the per-provider sibling
 *      pattern stopped at `sendingDomainMtaIdentities` /
 *      `sendingDomainSesIdentities`, which stay frozen.
 *   3. Add one entry to `SENDING_DOMAIN_PROVIDERS` below.
 *
 * The compile-time `satisfies` check on the registry catches missing methods.
 * The **Sending domain lifecycle (module)** never branches on `providerType`.
 *
 * Per ADR-0018, extended by plan D6/D7.
 */

import { mtaProvider } from './mta';
import { sesProvider } from './ses';
import type { ApiVerifiedSendProviderKind } from '../../lib/sendProviders/catalog';
import type { SendingDomainProviderKind, SendingDomainProviderModule } from './types';

export type {
	SendingDomainProviderKind,
	SendingDomainIdentityRegistry,
	SendingDomainProviderModule,
	ProviderIdentity,
	ProviderIdentityFor,
	MtaIdentity,
	SesIdentity,
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
} as const;

// Compile-time guard: each registry value must satisfy the adapter shape for
// its own kind. The mapped type pins each key to `Module<thatKey>`, so a
// missing method (or a kind mismatch) is a compile error.
const _typecheck: { [K in SendingDomainProviderKind]: SendingDomainProviderModule<K> } =
	SENDING_DOMAIN_PROVIDERS;
void _typecheck;

/**
 * Compile-time completeness guard (D6/D7): every send-transport kind whose
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
 */
type ApiVerifiedKindMissingProvider = Exclude<
	ApiVerifiedSendProviderKind,
	SendingDomainProviderKind
>;
type AssertEveryApiVerifiedKindHasProvider<_T extends never> = true;
export type _ApiVerifiedKindsHaveDomainProviders =
	AssertEveryApiVerifiedKindHasProvider<ApiVerifiedKindMissingProvider>;

/**
 * Look up the adapter for a provider kind. Throws on unknown kinds —
 * `domains.providerType` is validated as a literal union before this is
 * called, so a throw here means a data-integrity bug (or a brand-new provider
 * landed without a registry entry).
 */
export function providerFor<K extends SendingDomainProviderKind>(
	kind: K
): SendingDomainProviderModule<K> {
	const mod = SENDING_DOMAIN_PROVIDERS[kind];
	if (!mod) {
		throw new Error(`Unknown sending domain provider: ${kind}`);
	}
	return mod as unknown as SendingDomainProviderModule<K>;
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
