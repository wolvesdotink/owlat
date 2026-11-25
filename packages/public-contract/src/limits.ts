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

const recipientSendUsageSchema = z
	.strictObject({
		email: z.string().meta({
			description: 'The address, trimmed and lowercased as the send route stores it.',
		}),
		templateId: z.string().meta({ description: 'ID of the template.' }),
		slug: z.string().meta({ description: 'Slug of the template.' }),
		isExempt: z.boolean().meta({
			description: 'Whether the template is exempt from the cap; then nothing is counted.',
		}),
		used: z.number().int().nullable().meta({
			description:
				'Sends counted against the pair now, rounded up; null while the cap is off or the template is exempt.',
		}),
		remaining: z.number().int().nullable().meta({
			description:
				'Sends of the template to the address that fit now, never below 0; null while the cap is off or the template is exempt.',
		}),
		resetsAt: z.string().nullable().meta({
			description: 'ISO 8601 time the count is back to zero; null when nothing is counted.',
		}),
	})
	.meta({
		description:
			'What one template sent to one address under this cap. Given only when the request names both with `email` and `slug` or `transactionalId`.',
	});

const recipientSendLimitSchema = z
	.strictObject({
		isEnabled: z.boolean().meta({ description: 'Whether the instance admin has the cap on.' }),
		limit: z.number().int().meta({
			description: 'Sends allowed per template and address within the window.',
		}),
		windowSeconds: z.number().int().meta({ description: 'Length of the window, in seconds.' }),
		usage: recipientSendUsageSchema.optional(),
	})
	.meta({
		description:
			'The cap on sends of one template to one address: a send over it answers 429 with Retry-After. The allowance refills continuously, limit per window. A template can be exempt from it.',
	});

export const sendLimitsSchema = z.strictObject({
	dailySends: dailySendLimitSchema,
	recipientSends: recipientSendLimitSchema,
});
