/**
 * AN OPERATOR ACTION, RECORDED — the write half every control mutation shares
 * (plan D12, P3-6).
 *
 * D12 IS NOT "THE CONTROLLER IS AUDITED", IT IS "EVERY DECISION IS AUDITED". A
 * human pinning a cell at 20% is a decision about that cell's share, and if it
 * only reached `auditLogs` then the `mixDecisions` timeline — the one place an
 * operator goes to ask "why is this cell not moving" — would show an unbroken
 * run of controller holds with no visible cause. So an operator action writes
 * BOTH: a `mixDecisions` row carrying the move and its human-readable reason,
 * and an `auditLogs` entry naming the person who made it.
 *
 * The two are written by the SAME helper so they cannot drift: an action in the
 * log with no decision row, or a decision row attributed to nobody, are both
 * states this module makes unrepresentable.
 */

import {
	deliverabilityCellKey,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import type { MutationCtx } from '../_generated/server';
import { recordAuditLog, type AuditAction, type AuditDetails } from '../lib/auditLog';
import type { RampDecisionReason } from './ramp/controllerTypes';
import { rampDecisionDirection } from './ramp/controllerTypes';

/** Operator decisions age out with the controller's own, on the same horizon. */
const MIX_DECISION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface OperatorRampAction {
	readonly organizationId: string;
	readonly userId: string;
	readonly cell: DeliverabilityCell;
	readonly action: AuditAction;
	readonly reason: RampDecisionReason;
	readonly fromShare: number;
	readonly toShare: number;
	/** One sentence naming the HUMAN as the cause. Required — this is the KPI. */
	readonly message: string;
	/** The action's own inputs, for replay. Flat scalars — the audit log's shape. */
	readonly detail: AuditDetails;
	readonly at: number;
}

/**
 * Record one operator action in both places.
 *
 * `verdict: 'not_evaluated'` is the truthful value and not a placeholder: no
 * gate was consulted, because the operator's hand is not a measurement. Reading
 * a gate verdict onto a manual move would let a force-advance masquerade in the
 * timeline as an evidence-backed increase, which is the exact confusion the
 * separate `operator_*` reasons exist to prevent.
 */
export async function recordOperatorRampAction(
	ctx: MutationCtx,
	action: OperatorRampAction
): Promise<void> {
	const cellKey = deliverabilityCellKey(action.cell);
	await ctx.db.insert('mixDecisions', {
		organizationId: action.organizationId,
		cell: cellKey,
		stream: action.cell.stream,
		destinationProvider: action.cell.destinationProvider,
		at: action.at,
		fromShare: action.fromShare,
		toShare: action.toShare,
		direction: rampDecisionDirection(action.fromShare, action.toShare),
		verdict: 'not_evaluated',
		reason: action.reason,
		message: action.message,
		snapshot: JSON.stringify({
			cell: cellKey,
			operator: action.userId,
			action: action.action,
			at: action.at,
			detail: action.detail,
		}),
		expiresAt: action.at + MIX_DECISION_RETENTION_MS,
	});
	await recordAuditLog(ctx, {
		userId: action.userId,
		organizationId: action.organizationId,
		action: action.action,
		resource: 'deliverability_ramp',
		resourceId: cellKey,
		details: {
			cell: cellKey,
			fromShare: action.fromShare,
			toShare: action.toShare,
			reason: action.reason,
			message: action.message,
			...action.detail,
		},
	});
}
