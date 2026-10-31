/**
 * The per-domain return path's provider lookup.
 *
 * Which kinds accept a custom host, which hosts fit, which `mailFrom` bundle a
 * host publishes and which action reflects it are each module's own
 * declaration (`SendingDomainReturnPath`, `providers/returnPathTypes.ts`).
 * `lifecycle.create` validates through it, and `lifecycleReturnPath.ts` edits,
 * reconciles and reflects through it.
 */

import { isSendingDomainProviderKind, providerFor } from './providers';
import type { SendingDomainReturnPath } from './providers/returnPathTypes';

/**
 * The return-path support of a domain row's provider, or `null` when that
 * provider manages its own bounce path. `providerType` is the row's raw field:
 * a legacy row with no recorded kind, or a kind this registry does not know,
 * gets `null` rather than a guess.
 */
export function returnPathProviderFor(
	providerType: string | undefined
): SendingDomainReturnPath | null {
	if (!isSendingDomainProviderKind(providerType)) return null;
	return providerFor(providerType).returnPath ?? null;
}
