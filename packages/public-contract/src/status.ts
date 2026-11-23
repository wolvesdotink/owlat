/**
 * `GET /api/v1/status`: whether the instance can send, and why not.
 */

import { z } from 'zod';
import {
	DELIVERY_FIX_AUDIENCES,
	DELIVERY_STATUS_LEVELS,
	DELIVERY_STATUS_REASONS,
	SENDING_DOMAIN_STATUSES,
} from './types';

const rateAgainstLimitSchema = z.strictObject({
	ratePct: z.number().meta({ description: 'The rate in percent, to three decimals.' }),
	limitPct: z.number().meta({ description: 'The limit in percent.' }),
	isOver: z.boolean().meta({ description: 'Whether the rate has reached the limit.' }),
});

export const deliveryStatusSchema = z.strictObject({
	level: z.enum(DELIVERY_STATUS_LEVELS).meta({
		description: 'How sending stands overall: error blocks some or all mail, warn needs attention.',
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
		.meta({ description: 'The rolling rates; null while nothing was sent in the window.' }),
	sendingHold: z
		.strictObject({
			status: z.enum(['suspended', 'banned']),
			since: z.string().nullable().meta({
				description: 'ISO 8601 timestamp of when the status was set; null if not recorded.',
			}),
			detail: z.string().nullable().meta({
				description: 'The reason recorded with the status, or null.',
			}),
		})
		.nullable()
		.meta({
			description:
				'The suspension or ban in force, with the fields of the transactional 403 abuse_blocked refusal; null while sending is allowed.',
		}),
});
