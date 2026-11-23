/**
 * `GET /api/v1/limits`: the transactional send limits that apply to the
 * asking key, and what is left of them.
 */

import { z } from 'zod';

const dailySendLimitSchema = z.strictObject({
	isEnabled: z.boolean().meta({ description: 'Whether the instance admin has the cap on.' }),
	limit: z.number().int().meta({
		description: 'Sends allowed per API key and UTC day; kept while the cap is off.',
	}),
	used: z.number().int().nullable().meta({
		description:
			'Sends counted against this key today; null while the cap is off, since none are counted.',
	}),
	remaining: z.number().int().nullable().meta({
		description: 'Sends this key may still make today, never below 0; null while the cap is off.',
	}),
	resetsAt: z.string().nullable().meta({
		description:
			'ISO 8601 time the count starts again (the next UTC midnight); null while the cap is off.',
	}),
});

const recipientSendLimitSchema = z
	.strictObject({
		isEnabled: z.boolean().meta({ description: 'Whether the instance admin has the cap on.' }),
		limit: z.number().int().meta({
			description: 'Sends allowed per template and address within the window.',
		}),
		windowSeconds: z.number().int().meta({ description: 'Length of the window, in seconds.' }),
	})
	.meta({
		description:
			'The cap on sends of one template to one address. What is left depends on the template and the address, so no count is given: a send over it answers 429 with Retry-After. The allowance refills continuously, limit per window. A template can be exempt from it.',
	});

export const sendLimitsSchema = z.strictObject({
	dailySends: dailySendLimitSchema,
	recipientSends: recipientSendLimitSchema,
});
