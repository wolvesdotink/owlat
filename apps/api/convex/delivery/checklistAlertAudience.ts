/**
 * Who a deliverability regression alert is for: the organization's owners and
 * admins, the people who can act on the Deliverability Center. The alert email
 * (`checklistAlerts.ts`, a Node action) and the alert channel summary (a
 * query) read the same list, so the summary's "Email to 2 people" counts the
 * people the email goes to.
 *
 * Not a Convex function module.
 */

import {
	DELIVERABILITY_ALERT_RECIPIENT_LIMIT,
	type DeliverabilityAlertAdminRecipient,
} from '@owlat/shared';
import { components } from '../_generated/api';
import type { ActionCtx, QueryCtx } from '../_generated/server';

/** The one call this needs; an action's and a query's context both have it. */
type DirectoryReader = Pick<ActionCtx, 'runQuery'> | Pick<QueryCtx, 'runQuery'>;

function normalizedEmail(value: string | undefined): string | undefined {
	const email = value?.trim().toLowerCase();
	return email || undefined;
}

export async function loadDeliverabilityAlertAdminRecipients(
	ctx: DirectoryReader,
	organizationId: string
): Promise<DeliverabilityAlertAdminRecipient[]> {
	// Both signatures take the same component query; TypeScript cannot call a
	// union of overloads, so it is read through one of them.
	const runQuery = ctx.runQuery as QueryCtx['runQuery'];
	const results = await Promise.all(
		(['owner', 'admin'] as const).map(
			(role) =>
				runQuery(components.betterAuth.adapter.findMany, {
					model: 'member',
					where: [
						{ field: 'organizationId', value: organizationId },
						{ field: 'role', value: role },
					],
					paginationOpts: {
						cursor: null,
						numItems: DELIVERABILITY_ALERT_RECIPIENT_LIMIT,
					},
				}) as Promise<{
					page?: Array<{ userId: string; role: string }>;
				} | null>
		)
	);
	const userIds = [
		...new Set(results.flatMap((result) => result?.page ?? []).map((member) => member.userId)),
	]
		.sort()
		.slice(0, DELIVERABILITY_ALERT_RECIPIENT_LIMIT);
	const users = await Promise.all(
		userIds.map(
			(userId) =>
				runQuery(components.betterAuth.adapter.findOne, {
					model: 'user',
					where: [{ field: '_id', value: userId }],
				}) as Promise<{ email?: string } | null>
		)
	);
	return userIds.map((userId, index) => {
		const email = normalizedEmail(users[index]?.email);
		return { userId, ...(email ? { email } : {}) };
	});
}
