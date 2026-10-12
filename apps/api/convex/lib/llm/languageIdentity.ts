/**
 * The secret-free execution identity of a resolved language model (ADR-0073;
 * clarify lane, Sol r4 F1 and r5 F1): `<provider kind>|<model>|<endpoint>`,
 * where the endpoint is the embed lane's `endpointIdentity` of the base URL
 * (its origin, plus a SHA-256 prefix of the userinfo, path and query requests
 * carry), empty without a base URL. Two resolutions answer alike only when
 * this is equal, so a stored decision answer stamped with another is not
 * reused: another provider, model, host or base path asks again.
 *
 * Pure and runtime-neutral.
 */

import { endpointIdentity } from '../embeddingSpace';

export function languageModelIdentity(
	kind: string,
	modelId: string,
	baseUrl: string | undefined
): string {
	return [kind, modelId, baseUrl ? endpointIdentity(baseUrl) : ''].join('|');
}
