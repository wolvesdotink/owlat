/**
 * Mailchimp integration import provider adapter.
 *
 * Owns the Mailchimp-side surface of one **Integration import** run —
 * config validation, HTTP fetch, response parsing, and normalization
 * into `ImportRow[]` for the **Contact import (module)**.
 *
 * Cursor convention: empty string is the first-page sentinel; otherwise
 * the cursor is a stringified numeric `offset`. Terminal page returns
 * `nextCursor: null`.
 *
 * Per ADR-0027.
 */

import {
	RetryableProviderError,
	type FetchPageResult,
	type IntegrationImportProviderModule,
	type SuppressionRow,
} from '../../_common';
import type { ImportRow } from '../../../contacts/import';

const PAGE_SIZE = 100;

interface MailchimpMember {
	email_address: string;
	status: string;
	merge_fields?: {
		FNAME?: string;
		LNAME?: string;
		[key: string]: string | undefined;
	};
}

interface MailchimpListResponse {
	members: MailchimpMember[];
	total_items: number;
}

/**
 * What one non-subscribed audience member means for Owlat's suppression state
 * (plan D9), or `null` when it means nothing.
 *
 * NO SECOND FETCH IS NEEDED, and that is the whole shape of this feature on the
 * Mailchimp side. `GET /lists/{id}/members` is not status-filtered here: every
 * page the contacts import already walks carries the audience's `unsubscribed`
 * and `cleaned` members too, and the importer's only use for them until now was
 * to `continue` past them. So the carry-over adds no request, no second paging
 * pass, no extra rate-limit exposure — it routes rows that were already on the
 * wire and were being dropped.
 *
 *  - `unsubscribed` — a departure. Routed to the CONSENT path, not the
 *    blocklist: Owlat has membership deletes, an opt-out stamp, campaign
 *    counters and a `topic.unsubscribed` webhook for this, and a blocklist row
 *    would record the outcome while skipping all of it.
 *  - `cleaned` — Mailchimp's word for "this address hard-bounced (or repeatedly
 *    failed) and we stopped mailing it". Mailbox evidence, and the strongest
 *    kind: `bounced`/`hard`, which the MTA mirror makes a permanent backstop
 *    entry.
 *  - `pending` (double opt-in in flight), `transactional`, `archived`, and any
 *    status Mailchimp adds later — NOT suppressions. A pending member has not
 *    said no, and an archived one is an audience-management decision about a
 *    list, not a statement about the mailbox. Suppressing on either would let a
 *    tidy-up in Mailchimp permanently silence an address here. They are counted
 *    as skipped so the run summary accounts for every member the page saw.
 */
function suppressionForStatus(member: MailchimpMember): SuppressionRow | null {
	const email = member.email_address.toLowerCase();
	if (member.status === 'unsubscribed') {
		return { email, reason: 'unsubscribe', evidence: 'unsubscribed' };
	}
	if (member.status === 'cleaned') {
		return { email, reason: 'bounced', bounceType: 'hard', evidence: 'cleaned' };
	}
	return null;
}

export const mailchimpProvider: IntegrationImportProviderModule<'mailchimp'> = {
	kind: 'mailchimp',
	contactSource: 'mailchimp',
	defaultDoiAttest: 'mailchimp',

	validateConfig(config) {
		const datacenter = config.apiKey.split('-').pop();
		// Strict format check: Mailchimp datacenters are always two letters +
		// digits (e.g. us21, eu1). Anything else — including wildcard-DNS
		// payloads like "1.2.3.4.nip.io" — would let a malicious key steer
		// the Convex action's HTTP request toward an attacker-chosen host.
		if (!datacenter || !/^[a-z]{2}\d+$/.test(datacenter)) {
			return {
				ok: false,
				reason:
					'Invalid Mailchimp API key format. Expected format: apikey-datacenter (e.g., abc123-us21)',
			};
		}
		if (!config.listId) {
			return { ok: false, reason: 'Mailchimp listId is required' };
		}
		return { ok: true };
	},

	async fetchPage({ config, cursor }): Promise<FetchPageResult> {
		const offset = cursor === '' ? 0 : parseInt(cursor, 10);
		const datacenter = config.apiKey.split('-').pop();
		if (!datacenter || !/^[a-z]{2}\d+$/.test(datacenter)) {
			throw new Error(
				'Invalid Mailchimp API key format. Expected format: apikey-datacenter (e.g., abc123-us21)'
			);
		}

		const url =
			`https://${datacenter}.api.mailchimp.com/3.0/lists/${config.listId}/members` +
			`?count=${PAGE_SIZE}&offset=${offset}` +
			`&fields=members.email_address,members.status,members.merge_fields,total_items`;

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'GET',
				headers: {
					Authorization: `Basic ${Buffer.from(`anystring:${config.apiKey}`).toString('base64')}`,
					'Content-Type': 'application/json',
				},
			});
		} catch (err) {
			throw new RetryableProviderError(
				`Network error fetching Mailchimp page at offset ${offset}: ${err instanceof Error ? err.message : 'unknown'}`
			);
		}

		if (response.status === 429) {
			throw new RetryableProviderError(`Mailchimp rate limit (429) at offset ${offset}`);
		}
		if (!response.ok) {
			const errorText = await response.text();
			let errorMessage = `Mailchimp API error: ${response.status}`;
			try {
				const errorJson = JSON.parse(errorText);
				errorMessage = errorJson.detail || errorJson.title || errorMessage;
			} catch {
				// Non-JSON error response — fall through with status-only message.
			}
			throw new Error(errorMessage);
		}

		const data = (await response.json()) as MailchimpListResponse;

		// Extract subscribed contacts. Mailchimp's `merge_fields` carries
		// customer-defined keys beyond FNAME/LNAME (COMPANY, TIER, etc.);
		// we pluck the name fields into `firstName`/`lastName` and pass the
		// rest through as `properties` — the **Contact import (module)**
		// auto-registers unknown property keys on `mailchimp` source.
		const rows: ImportRow[] = [];
		const suppressions: SuppressionRow[] = [];
		let suppressionsSkipped = 0;
		for (const member of data.members) {
			if (member.status !== 'subscribed') {
				if (config.importSuppressions) {
					const carried = suppressionForStatus(member);
					if (carried) suppressions.push(carried);
					else suppressionsSkipped++;
				}
				continue;
			}
			const mergeFields = member.merge_fields ?? {};
			const properties: Record<string, string | number | boolean | null> = {};
			for (const [key, value] of Object.entries(mergeFields)) {
				if (key === 'FNAME' || key === 'LNAME') continue;
				if (value == null || value === '') continue;
				properties[key] = value;
			}
			rows.push({
				email: member.email_address.toLowerCase(),
				firstName: mergeFields.FNAME,
				lastName: mergeFields.LNAME,
				...(Object.keys(properties).length > 0 ? { properties } : {}),
			});
		}

		const nextOffset = offset + PAGE_SIZE;
		const nextCursor: string | null = data.members.length === PAGE_SIZE ? String(nextOffset) : null;

		return {
			rows,
			nextCursor,
			totalEstimate: data.total_items,
			...(suppressions.length > 0 ? { suppressions } : {}),
			...(suppressionsSkipped > 0 ? { suppressionsSkipped } : {}),
		};
	},
};
