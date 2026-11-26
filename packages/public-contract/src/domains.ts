/**
 * `GET /api/v1/domains`: each sending domain with the DNS records it needs
 * and what the last check found.
 */

import { z } from 'zod';
import {
	DNS_RECORD_PURPOSES,
	DNS_RECORD_STATES,
	DNS_RECORD_TYPES,
	SENDING_DOMAIN_STATUSES,
} from './types';

const sendingDomainRecordSchema = z.strictObject({
	purpose: z.enum(DNS_RECORD_PURPOSES).meta({
		description:
			'What the record does: SPF, a DKIM key, DMARC, or the return-path (MAIL FROM) host.',
	}),
	type: z.enum(DNS_RECORD_TYPES),
	host: z.string().meta({ description: "The record's full name." }),
	value: z.string().meta({ description: 'The value to publish.' }),
	priority: z
		.number()
		.int()
		.nullable()
		.meta({ description: 'The MX priority; null for every other type.' }),
	state: z.enum(DNS_RECORD_STATES).meta({
		description:
			'What the last check found: found with the expected value, wrong (another value), missing, or unchecked (no check yet, or DNS gave no answer).',
	}),
	foundValue: z.string().nullable().meta({
		description: 'The value the last check found instead, while state is wrong; otherwise null.',
	}),
	optional: z.boolean().meta({
		description:
			'True for a record the domain does not need, whose state never decides whether the domain is verified: the optional second DKIM key (Ed25519, k=ed25519). False for every other record.',
	}),
});

export const sendingDomainSetupSchema = z.strictObject({
	id: z.string(),
	domain: z.string(),
	status: z.enum(SENDING_DOMAIN_STATUSES).meta({
		description: 'Verification state. Only a verified domain can send.',
	}),
	lastCheckedAt: z.string().nullable().meta({
		description:
			'ISO 8601 timestamp of the last check that reached a verdict, or null before the first.',
	}),
	records: z.array(sendingDomainRecordSchema).meta({
		description: 'Every record to publish; empty while the domain is still being registered.',
	}),
});

/** The list is the whole set: an instance has a handful of sending domains, so it is not paged. */
export const sendingDomainSetupListSchema = z.array(sendingDomainSetupSchema);

export const domainCheckRequestSchema = z.strictObject({
	id: z.string(),
	domain: z.string(),
	status: z.enum(SENDING_DOMAIN_STATUSES).meta({
		description: 'Verification state before the check.',
	}),
	lastCheckedAt: z.string().nullable().meta({
		description:
			'ISO 8601 timestamp of the last check that reached a verdict, or null before the first.',
	}),
	requestedAt: z.string().meta({
		description:
			'ISO 8601 timestamp the check was requested. Once `lastCheckedAt` in `GET /api/v1/domains` is at or after it, a check that reached a verdict has landed since the request: this one, or another check of the domain (every check that reaches a verdict moves the same timestamp).',
	}),
});
