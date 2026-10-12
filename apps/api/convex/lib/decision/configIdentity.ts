/**
 * The decision plane's identity and locality (ADR-0060 §8 and §9).
 *
 * IDENTITY is derived from the RESOLVED plane (`lib/decisionProvider.ts`
 * `resolveDecisionConfig`), never re-derived from stored columns: the
 * resolver alone owns the stored-then-env precedence for the kind, the model
 * and the origin, so the identity changes exactly when the endpoint a call
 * would use changes. A bundle stamps its answer with the identity of the
 * plane it dispatched to (`decision/bundleRunner.ts`); the block-only gate
 * compares it with the identity of the plane resolved at send time
 * (`decision/planeIdentity.ts`).
 *
 * LOCALITY for scheduling is a pre-filter read in a query, so it reads only
 * the configured KIND: the local engine is local, TypeSafe and the
 * language-backed adapter are hosted, whatever their origin. The authoritative
 * check is the claim, against the endpoint actually resolved for the call.
 *
 * Pure and isolate-safe apart from the env read, which goes through
 * `lib/env.ts`.
 */

import { getOptional } from '../env';
import { resolveEndpointLocality } from '../llm/endpointLocality';
import {
	DECISION_PROVIDER_KINDS,
	DEFAULT_DECISION_KIND,
	type DecisionProviderKind,
} from '../decisionProviders/types';

/** The fields of a resolved decision plane its identity is made of. */
export interface ResolvedPlaneIdentityInput {
	readonly kind: DecisionProviderKind;
	readonly modelId: string;
	readonly clientConfig: { readonly baseUrl?: string };
	/** Set when the configured provider cannot answer (D3). */
	readonly degradedFrom?: DecisionProviderKind;
}

/**
 * `off` while the plane is off, `unavailable:<kind>` when the configured
 * provider cannot answer, otherwise `<kind>|<model>|<origin>` of the resolved
 * plane. Secret free.
 */
export function resolvedPlaneIdentity(
	plane: ResolvedPlaneIdentityInput | null,
	isDecisionPlaneOn: boolean
): string {
	if (!isDecisionPlaneOn) return 'off';
	if (plane === null) return 'unavailable';
	if (plane.degradedFrom !== undefined) return `unavailable:${plane.degradedFrom}`;
	return [plane.kind, plane.modelId, plane.clientConfig.baseUrl ?? ''].join('|');
}

/** The decision provider KIND as configured: a stored kind, else `DECISION_PROVIDER`, else the default. */
function configuredKind(
	row: {
		readonly decisionProviderKind?: DecisionProviderKind;
	} | null
): DecisionProviderKind {
	if (row?.decisionProviderKind !== undefined) return row.decisionProviderKind;
	const fromEnv = getOptional('DECISION_PROVIDER')?.trim();
	return DECISION_PROVIDER_KINDS.find((kind) => kind === fromEnv) ?? DEFAULT_DECISION_KIND;
}

/**
 * Whether the configured decision plane is the operator's own engine: the
 * scheduling pre-filter for a mailbox excluded from hosted decisions. Only the
 * `local` kind is; every other kind is hosted whatever its origin, and the
 * claim checks the resolved endpoint again before any call.
 */
export function isLocalDecisionEngine(
	row: { readonly decisionProviderKind?: DecisionProviderKind } | null,
	isDecisionPlaneOn: boolean
): boolean {
	return isDecisionPlaneOn && resolveEndpointLocality(configuredKind(row), undefined) === 'local';
}
