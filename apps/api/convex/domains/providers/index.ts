/**
 * Sending domain provider adapter (module) — registry + dispatch.
 *
 * Adding a third sending provider is a one-folder change:
 *   1. Create `convex/domains/providers/<kind>/index.ts` with the adapter.
 *   2. Add the per-provider sibling identity table to `schema/domains.ts`.
 *   3. Add one entry to `SENDING_DOMAIN_PROVIDERS` below.
 *
 * The compile-time `satisfies` check on the registry catches missing methods.
 * The **Sending domain lifecycle (module)** never branches on `providerType`.
 *
 * Per ADR-0018.
 */

import { mtaProvider } from './mta';
import { sesProvider } from './ses';
import type {
	SendingDomainProviderKind,
	SendingDomainProviderModule,
} from './types';

export type {
	SendingDomainProviderKind,
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
 * Look up the adapter for a provider kind. Throws on unknown kinds —
 * `domains.providerType` is validated as a literal union before this is
 * called, so a throw here means a data-integrity bug (or a brand-new provider
 * landed without a registry entry).
 */
export function providerFor<K extends SendingDomainProviderKind>(
	kind: K,
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
 */
export function isSendingDomainProviderKind(
	kind: string | undefined | null,
): kind is SendingDomainProviderKind {
	return kind === 'mta' || kind === 'ses';
}
