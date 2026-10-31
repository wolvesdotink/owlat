/**
 * The decision plane's identity and locality.
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
import { exactEndpointIdentity } from '../llm/languageIdentity';
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
	/** Set when the configured provider cannot answer; `kind` stays the configured one. */
	readonly unavailable?: { readonly code: string };
}

/**
 * `off` while the plane is off, `unavailable:<kind>` when the configured
 * provider cannot answer, otherwise `<kind>|<model>|<endpoint>` of the resolved
 * plane. Secret free: the endpoint is {@link exactEndpointIdentity} of the base
 * URL the adapter is given (its origin and a digest of the string), because an
 * accepted path or query may carry a credential and the identity is stored on
 * every decision artifact. It changes whenever the URL the adapter dispatches
 * to changes; the adapter's default endpoint (no base URL) is the empty part.
 */
export function resolvedPlaneIdentity(
	plane: ResolvedPlaneIdentityInput | null,
	isDecisionPlaneOn: boolean
): string {
	if (!isDecisionPlaneOn) return 'off';
	if (plane === null) return 'unavailable';
	if (plane.unavailable !== undefined) return `unavailable:${plane.kind}`;
	const { baseUrl } = plane.clientConfig;
	return [plane.kind, plane.modelId, baseUrl ? exactEndpointIdentity(baseUrl) : ''].join('|');
}

/**
 * The configuration version of the `aiProviderConfig` row: its id and its
 * `configRevision` (bumped by every save; a row written before the column
 * reads as 0), or undefined without a row. The snapshot the decision plane's
 * cache, its rung and the bundle claim compare: two saves in one millisecond
 * share `updatedAt`, never this, and a removed and re-created row has a new id.
 */
export function configVersionOf(
	row: { readonly _id: string; readonly configRevision?: number } | null
): string | undefined {
	return row ? `${row._id}:${row.configRevision ?? 0}` : undefined;
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
