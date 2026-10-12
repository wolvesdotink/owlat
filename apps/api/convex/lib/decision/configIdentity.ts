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

/** `off` when the plane is off; otherwise `<kind>|<model>|<origin>` as configured. */
export function decisionConfigIdentity(
	row: DecisionConfigColumns | null,
	isDecisionPlaneOn: boolean
): string {
	if (!isDecisionPlaneOn) return 'off';
	if (row?.decisionProviderKind !== undefined) {
		return [row.decisionProviderKind, row.decisionModel ?? '', row.decisionBaseUrl ?? ''].join('|');
	}
	const envKind = DECISION_PROVIDER_KINDS.find((kind) => kind === env('DECISION_PROVIDER'));
	if (envKind !== undefined) {
		return [envKind, env('DECISION_MODEL'), env('DECISION_BASE_URL')].join('|');
	}
	return [DEFAULT_DECISION_KIND, '', ''].join('|');
}
