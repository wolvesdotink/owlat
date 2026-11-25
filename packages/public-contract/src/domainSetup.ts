/**
 * The body of `GET /api/v1/domains`: each sending domain with the DNS records
 * it needs and what the last check found. Plain TypeScript, re-exported by
 * `types.ts`; see there for why. Its one import is a sibling plain module.
 */

import type { SendingDomainStatusValue } from './deliveryStatus';

/** What a record does: SPF, a DKIM key, DMARC, or the return-path (MAIL FROM) host. */
export const DNS_RECORD_PURPOSES = ['spf', 'dkim', 'dmarc', 'mail_from'] as const;

/** What a record does. */
export type DnsRecordPurpose = (typeof DNS_RECORD_PURPOSES)[number];

/** DNS record types a sending domain asks for. */
export const DNS_RECORD_TYPES = ['TXT', 'CNAME', 'MX'] as const;

/** A DNS record type. */
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

/**
 * What the last check found at the record's name: `found` with the expected
 * value, `wrong` (a record is there with another value), `missing` (no such
 * record), or `unchecked` (no check has run yet, or DNS gave no answer).
 */
export const DNS_RECORD_STATES = ['found', 'wrong', 'missing', 'unchecked'] as const;

/** What the last check found at the record's name. */
export type DnsRecordState = (typeof DNS_RECORD_STATES)[number];

/** One DNS record a sending domain needs published. */
export interface SendingDomainRecord {
	purpose: DnsRecordPurpose;
	type: DnsRecordType;
	/** The record's full name, where it is published and looked up. */
	host: string;
	/** The value to publish. */
	value: string;
	/** The MX priority; `null` for every other type. */
	priority: number | null;
	state: DnsRecordState;
	/** The value the last check found instead, while `state` is `wrong`; otherwise `null`. */
	foundValue: string | null;
}

/** A sending domain with its verification state and the records it needs. */
export interface SendingDomainSetup {
	id: string;
	domain: string;
	status: SendingDomainStatusValue;
	/** ISO 8601 timestamp of the last check that reached a verdict, or `null` before the first. */
	lastCheckedAt: string | null;
	/** Every record to publish; empty while the domain is still being registered. */
	records: SendingDomainRecord[];
}

/**
 * Body of `POST /api/v1/domains/{domain}/verify`: the check is queued. The
 * domain's state is the one before the check; read `GET /api/v1/domains` for
 * the result once `lastCheckedAt` is at or after `requestedAt`. Every check of
 * the domain that reaches a verdict moves that timestamp, so it shows that a check reached a verdict
 * since the request, not which one.
 */
export interface DomainCheckRequest {
	id: string;
	domain: string;
	/** Verification state before the check. */
	status: SendingDomainStatusValue;
	/** ISO 8601 timestamp of the last check that reached a verdict, or `null` before the first. */
	lastCheckedAt: string | null;
	/** ISO 8601 timestamp the check was requested. */
	requestedAt: string;
}
