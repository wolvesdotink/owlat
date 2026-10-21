/**
 * The decision provider the environment names (`DECISION_PROVIDER`), told
 * apart from no value at all.
 *
 * An unset or blank variable means the deployment did not choose, and the
 * plane keeps its default. A value that is not a decision provider is an
 * explicit choice nobody can honour: the plane is unavailable (terminal, never
 * the language-backed adapter in disguise), and the settings status says why.
 * Runtime-neutral: the resolver (Node) and the settings query share it.
 */

import { getOptional } from './env';
import { DECISION_PROVIDER_KINDS, type DecisionProviderKind } from './decisionProviders/types';

export type EnvDecisionKind =
	| { readonly kind: DecisionProviderKind }
	| { readonly invalid: string }
	| undefined;

export function envDecisionKind(): EnvDecisionKind {
	const configured = getOptional('DECISION_PROVIDER')?.trim();
	if (!configured) return undefined;
	const kind = DECISION_PROVIDER_KINDS.find((candidate) => candidate === configured);
	return kind ? { kind } : { invalid: configured };
}

/** Why the environment's decision provider cannot be used, or undefined. */
export function decisionEnvProblem(): string | undefined {
	const env = envDecisionKind();
	if (!env || 'kind' in env) return undefined;
	return (
		`DECISION_PROVIDER is set to '${env.invalid}', which is not a decision provider ` +
		`(${DECISION_PROVIDER_KINDS.join(', ')}). Decisions are refused until it is corrected.`
	);
}
