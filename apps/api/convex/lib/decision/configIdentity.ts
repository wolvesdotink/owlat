/**
 * The identity of the decision plane as it is configured right now, secret
 * free, for ADR-0060 §8's rule that a verdict from a different provider than
 * the one configured now must not auto-send. An artifact stores the identity
 * it was answered under (`decisionArtifacts.contextVersion`); the block-only
 * gate compares it with this value at send time.
 *
 * It follows `lib/decisionProvider.ts`'s precedence (a stored kind, else
 * `DECISION_PROVIDER`, else the language-backed default) without resolving or
 * decrypting anything, so a query can compute it. A changed kind, model or
 * origin, or the plane switched off, is a different identity. Pure and
 * isolate-safe apart from the env read, which goes through `lib/env.ts`.
 */

import { getOptional } from '../env';
import { resolveEndpointLocality } from '../llm/endpointLocality';
import {
	DECISION_PROVIDER_KINDS,
	DEFAULT_DECISION_KIND,
	type DecisionProviderKind,
} from '../decisionProviders/types';

/** The stored decision columns the identity reads (`aiProviderConfig`). */
export interface DecisionConfigColumns {
	readonly decisionProviderKind?: DecisionProviderKind;
	readonly decisionModel?: string;
	readonly decisionBaseUrl?: string;
}

function env(key: 'DECISION_PROVIDER' | 'DECISION_MODEL' | 'DECISION_BASE_URL'): string {
	return getOptional(key)?.trim() ?? '';
}

/** The decision plane as configured (kind, model, origin), or null while it is off. */
export function configuredDecisionPlane(
	row: DecisionConfigColumns | null,
	isDecisionPlaneOn: boolean
): { kind: DecisionProviderKind; model: string; baseUrl: string } | null {
	if (!isDecisionPlaneOn) return null;
	if (row?.decisionProviderKind !== undefined) {
		return {
			kind: row.decisionProviderKind,
			model: row.decisionModel ?? '',
			baseUrl: row.decisionBaseUrl ?? '',
		};
	}
	const envKind = DECISION_PROVIDER_KINDS.find((kind) => kind === env('DECISION_PROVIDER'));
	if (envKind !== undefined) {
		return { kind: envKind, model: env('DECISION_MODEL'), baseUrl: env('DECISION_BASE_URL') };
	}
	return { kind: DEFAULT_DECISION_KIND, model: '', baseUrl: '' };
}

/** `off` when the plane is off; otherwise `<kind>|<model>|<origin>` as configured. */
export function decisionConfigIdentity(
	row: DecisionConfigColumns | null,
	isDecisionPlaneOn: boolean
): string {
	const plane = configuredDecisionPlane(row, isDecisionPlaneOn);
	return plane ? [plane.kind, plane.model, plane.baseUrl].join('|') : 'off';
}

/**
 * Whether the configured decision plane runs on the operator's own hardware
 * (`lib/llm/endpointLocality.ts`, the ledger's locality rule): only then may
 * a mailbox excluded from hosted decisions be judged (ADR-0060 §9). The
 * language-backed adapter and TypeSafe are hosted; unknown is hosted.
 */
export function isLocalDecisionEngine(
	row: DecisionConfigColumns | null,
	isDecisionPlaneOn: boolean
): boolean {
	const plane = configuredDecisionPlane(row, isDecisionPlaneOn);
	return (
		plane !== null && resolveEndpointLocality(plane.kind, plane.baseUrl || undefined) === 'local'
	);
}
