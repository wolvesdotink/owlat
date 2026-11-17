import type { DeliverabilityCheckId } from '@owlat/shared';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import {
	DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT,
	boundedDeliverabilityAlertRecipientRows,
	cancelledDeliverabilityAlertRecipientPatch,
	deliverabilityAlertNotificationPatch,
	toDeliverabilityAlertRecipientState,
} from './checklistAlertRecipients';

export async function resolveDeliverabilityAlert(
	ctx: MutationCtx,
	alert: Doc<'deliverabilityRegressionAlerts'>,
	resolvedAt: number,
	options: { acknowledge: boolean; reason?: 'not_applicable' }
): Promise<void> {
	const recipients = boundedDeliverabilityAlertRecipientRows(
		await ctx.db
			.query('deliverabilityAlertRecipients')
			.withIndex('by_alert', (q) => q.eq('alertId', alert._id))
			.take(DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT + 1)
	);
	const states = recipients.map(toDeliverabilityAlertRecipientState);
	for (let index = 0; index < recipients.length; index += 1) {
		const recipient = recipients[index]!;
		const state = states[index]!;
		if (state.status !== 'pending') continue;
		Object.assign(state, cancelledDeliverabilityAlertRecipientPatch());
		await ctx.db.patch(recipient._id, cancelledDeliverabilityAlertRecipientPatch());
	}
	await ctx.db.patch(alert._id, {
		...(options.acknowledge ? { acknowledgedAt: alert.acknowledgedAt ?? resolvedAt } : {}),
		resolvedAt,
		...(options.reason ? { resolvedReason: options.reason } : {}),
		...deliverabilityAlertNotificationPatch(states, alert.compactedRecipientOutcomes),
	});
}

/** Resolve every open alert of one check on one target. */
export async function resolveOpenItemAlerts(
	ctx: MutationCtx,
	target: { organizationId: string; targetKey: string; itemId: DeliverabilityCheckId },
	resolvedAt: number,
	reason?: 'not_applicable'
): Promise<void> {
	const alerts = await ctx.db
		.query('deliverabilityRegressionAlerts')
		.withIndex('by_org_target_item_resolved', (q) =>
			q
				.eq('organizationId', target.organizationId)
				.eq('targetKey', target.targetKey)
				.eq('itemId', target.itemId)
				.eq('resolvedAt', undefined)
		)
		.take(50);
	for (const alert of alerts) {
		await resolveDeliverabilityAlert(ctx, alert, resolvedAt, {
			acknowledge: false,
			...(reason ? { reason } : {}),
		});
	}
}
