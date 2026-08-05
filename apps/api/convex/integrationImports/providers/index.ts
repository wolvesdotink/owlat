/**
 * Integration import provider adapter (module) — registry + dispatch.
 *
 * Adding another integration provider (HubSpot, Klaviyo, Brevo) is a
 * one-folder change:
 *   1. Create `convex/integrationImports/providers/<kind>/index.ts` with the
 *      adapter satisfying `IntegrationImportProviderModule<K>`.
 *   2. Add one branch to the `IntegrationProviderConfig` union in
 *      `_common.ts` and one entry to `INTEGRATION_PROVIDER_KINDS`.
 *   3. Add one entry to `INTEGRATION_IMPORT_PROVIDERS` below.
 *
 * The compile-time `satisfies` check on the registry catches missing
 * methods. The **Integration import walker** never branches on
 * `provider`.
 *
 * Per ADR-0027.
 */

import { mailchimpProvider } from './mailchimp';
import { stripeProvider } from './stripe';
import { mandrillProvider } from './mandrill';
import {
	INTEGRATION_PROVIDER_KINDS,
	type IntegrationImportProviderModule,
	type IntegrationProviderKind,
} from '../_common';

// Registry — keyed by `integrationImports.provider`. The walker calls
// `providerFor(kind)` to get the adapter; no caller imports adapters
// directly.
export const INTEGRATION_IMPORT_PROVIDERS = {
	mailchimp: mailchimpProvider,
	stripe: stripeProvider,
	mandrill: mandrillProvider,
} as const;

// Compile-time guard: each registry value must satisfy the adapter shape for
// its own kind. The mapped type pins each key to `Module<thatKey>`.
const _typecheck: {
	[K in IntegrationProviderKind]: IntegrationImportProviderModule<K>;
} = INTEGRATION_IMPORT_PROVIDERS;
void _typecheck;

/**
 * Look up the adapter for a provider kind. Throws on unknown kinds —
 * `integrationImports.provider` is validated as a literal union before this
 * is called, so a throw here means a data-integrity bug (or a new provider
 * landed without a registry entry).
 */
export function providerFor<K extends IntegrationProviderKind>(
	kind: K
): IntegrationImportProviderModule<K> {
	const mod = INTEGRATION_IMPORT_PROVIDERS[kind];
	if (!mod) {
		throw new Error(`Unknown integration import provider: ${kind}`);
	}
	return mod as unknown as IntegrationImportProviderModule<K>;
}

/**
 * Type guard: is the given string a recognized integration provider kind?
 */
export function isIntegrationProviderKind(
	kind: string | undefined | null
): kind is IntegrationProviderKind {
	// Read off the same list the registry's completeness guard uses, so adding a
	// provider cannot leave this guard behind (it did drift once: the literal
	// chain this replaced had to be edited by hand for every new kind).
	return (
		typeof kind === 'string' && (INTEGRATION_PROVIDER_KINDS as readonly string[]).includes(kind)
	);
}
