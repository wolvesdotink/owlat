export const NO_GATE_OBJECTION = Object.freeze({ outcome: 'no-objection' } as const);

export interface GateObjection {
	readonly outcome: 'objection';
	readonly reason: string;
}

/** A plugin gate can withhold approval, but has no result that grants approval. */
export type RestrictOnlyGateResult = typeof NO_GATE_OBJECTION | GateObjection;

export interface GateDecision {
	readonly allowed: boolean;
	readonly objections: readonly string[];
}

export function createGateObjection(reason: string): GateObjection {
	const normalizedReason = reason.trim();
	if (normalizedReason.length === 0) throw new TypeError('A gate objection requires a reason');
	return Object.freeze({ outcome: 'objection', reason: normalizedReason });
}

/**
 * Apply one gate result without ever widening the existing decision. Malformed
 * output is itself an objection, so a consumer that validates at this boundary
 * fails closed.
 */
export function applyRestrictOnlyGateResult(current: GateDecision, result: unknown): GateDecision {
	if (isNoGateObjection(result)) return freezeGateDecision(current);

	const objection = readGateObjection(result);
	const reason = objection ?? 'Plugin gate returned an invalid result';
	return Object.freeze({
		allowed: false,
		objections: Object.freeze([...current.objections, reason]),
	});
}

function isNoGateObjection(result: unknown): result is typeof NO_GATE_OBJECTION {
	return hasExactOutcome(result, 'no-objection') && Reflect.ownKeys(result).length === 1;
}

function readGateObjection(result: unknown): string | undefined {
	if (!hasExactOutcome(result, 'objection') || Reflect.ownKeys(result).length !== 2)
		return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(result, 'reason');
	if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
		return undefined;
	}
	const reason = descriptor.value.trim();
	return reason.length === 0 ? undefined : reason;
}

function hasExactOutcome(
	result: unknown,
	outcome: RestrictOnlyGateResult['outcome']
): result is Record<PropertyKey, unknown> {
	if (result === null || typeof result !== 'object') return false;
	const descriptor = Object.getOwnPropertyDescriptor(result, 'outcome');
	return !!descriptor && 'value' in descriptor && descriptor.value === outcome;
}

function freezeGateDecision(decision: GateDecision): GateDecision {
	return Object.freeze({
		allowed: decision.allowed === true,
		objections: Object.freeze([...decision.objections]),
	});
}
