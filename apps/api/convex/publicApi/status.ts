/**
 * What `GET /api/v1/status` answers (`./statusHttp.ts`): the explained
 * delivery-health report every member and the assistant read, in the public
 * contract's shape. The sending hold carries the fields of the transactional
 * `403 abuse_blocked` refusal, so a client reads one shape in both places.
 */

import type { DeliveryStatus, SendingHoldLift } from '@owlat/public-contract';
import { internalQuery } from '../_generated/server';
import { loadDeliveryHealthReport, readSendingHoldRecord } from '../delivery/healthReport';

export const getForApi = internalQuery({
	args: {},
	handler: async (ctx): Promise<DeliveryStatus> => {
		const { hold, ...report } = await loadDeliveryHealthReport(ctx);
		return {
			level: report.level,
			reasonCode: report.reasonCode,
			explanation: report.explanation,
			fix: report.fix,
			domains: report.domains,
			rates: report.rates,
			sendingHold: hold
				? {
						status: hold.status,
						since: hold.since === null ? null : new Date(hold.since).toISOString(),
						detail: hold.reason,
						lift: hold.lift,
					}
				: null,
		};
	},
});

/**
 * How the suspension in force lifts, for the transactional `403 abuse_blocked`.
 * Read in its own query after the intake refused, so the send path's
 * mutation keeps the reputation window out of its read set.
 */
export const sendingHoldLift = internalQuery({
	args: {},
	handler: async (ctx): Promise<SendingHoldLift | null> =>
		(await readSendingHoldRecord(ctx.db))?.lift ?? null,
});
