/**
 * `GET /api/v1/status`: whether the instance can send, and why not.
 */

import { z } from 'zod';
import {
	DELIVERY_FIX_AUDIENCES,
	DELIVERY_STATUS_LEVELS,
	DELIVERY_STATUS_REASONS,
	SENDING_DOMAIN_STATUSES,
	SENDING_HOLD_LIFT_MODES,
	SENDING_HOLD_TRIGGERS,
} from './types';

const rateAgainstLimitSchema = z.strictObject({
	ratePct: z.number().meta({ description: 'The rate in percent, to three decimals.' }),
	limitPct: z.number().meta({ description: 'The limit in percent.' }),
	isOver: z.boolean().meta({ description: 'Whether the rate has reached the limit.' }),
});

export const sendingHoldLiftSchema = z
	.strictObject({
		mode: z.enum(SENDING_HOLD_LIFT_MODES).meta({
			description:
				'automatic: lifts by itself once condition is met. manual_setting: the instance waits for a platform admin, even after the rates recover. admin: never lifts by itself (a ban, or a suspension a platform admin imposed). A platform admin can lift any of them.',
		}),
		condition: z
			.strictObject({
				trigger: z.enum(SENDING_HOLD_TRIGGERS).meta({
					description:
						"The metric the lift waits on: the 30-day bounce or complaint rate, or Gmail's spam rate for one sending domain.",
				}),
				domain: z.string().nullable().meta({
					description: 'The sending domain of a Gmail spam rate; null for the instance-wide rates.',
				}),
				currentPct: z.number().nullable().meta({
					description:
						'The metric now, in percent: the 30-day rate, or the highest Gmail reading at or above the limit. null when no evidence is left in the window.',
				}),
				limitPct: z.number().meta({
					description: 'Sending resumes once the metric is under this, in percent.',
				}),
				isClear: z.boolean().meta({
					description:
						'The metric is back under the limit: sending resumes at the next hourly check.',
				}),
				clearsAt: z.string().nullable().meta({
					description:
						'ISO 8601 time the last Gmail reading over the limit leaves the 30-day window; null otherwise.',
				}),
			})
			.nullable()
			.meta({ description: 'Set when mode is automatic, otherwise null.' }),
	})
	.meta({ description: 'How the suspension or ban lifts.' });

export const deliveryStatusSchema = z.strictObject({
	level: z.enum(DELIVERY_STATUS_LEVELS).meta({
		description:
			'How sending stands overall: error is a serious problem that affects or threatens delivery, warn needs attention. Whether sending is suspended now is sendingHold.',
	}),
	reasonCode: z.enum(DELIVERY_STATUS_REASONS).meta({
		description:
			'The worst problem, as a stable code. New codes can be added; treat an unknown one by its level.',
	}),
	explanation: z.string().meta({
		description: 'What the reason means and what to do about it, in English.',
	}),
	fix: z
		.strictObject({
			route: z.string().meta({ description: "Path of the page in the instance's web app." }),
			who: z.enum(DELIVERY_FIX_AUDIENCES).meta({ description: 'Who can make the fix there.' }),
		})
		.nullable()
		.meta({ description: 'Where the fix is made; null when there is nothing to fix.' }),
	domains: z.array(z.strictObject({ domain: z.string(), status: z.enum(SENDING_DOMAIN_STATUSES) })),
	rates: z
		.strictObject({
			windowDays: z.number().int().meta({ description: 'Length of the rolling window, in days.' }),
			sent: z.number().int().meta({ description: 'Emails sent in the window.' }),
			bounce: rateAgainstLimitSchema,
			complaint: rateAgainstLimitSchema,
		})
		.nullable()
		.meta({
			description:
				'The rolling rates; null while the window holds no sends, deliveries, bounces or complaints.',
		}),
	sendingHold: z
		.strictObject({
			status: z.enum(['suspended', 'banned']),
			since: z.string().nullable().meta({
				description: 'ISO 8601 timestamp of when the status was set; null if not recorded.',
			}),
			detail: z.string().nullable().meta({
				description: 'The reason recorded with the status, or null.',
			}),
			lift: sendingHoldLiftSchema,
		})
		.nullable()
		.meta({
			description:
				'The suspension or ban in force, with the fields of the transactional 403 abuse_blocked refusal; null while sending is allowed.',
		}),
});
