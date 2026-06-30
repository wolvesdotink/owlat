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

export const mailchimpProvider: IntegrationImportProviderModule<'mailchimp'> = {
	kind: 'mailchimp',
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
				'Invalid Mailchimp API key format. Expected format: apikey-datacenter (e.g., abc123-us21)',
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
				`Network error fetching Mailchimp page at offset ${offset}: ${err instanceof Error ? err.message : 'unknown'}`,
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
		for (const member of data.members) {
			if (member.status !== 'subscribed') continue;
			const mergeFields = member.merge_fields ?? {};
			const properties: Record<string, string | number | boolean | null> = {};
			for (const [key, value] of Object.entries(mergeFields)) {
				if (key === 'FNAME' || key === 'LNAME') continue;
				if (value === undefined || value === null || value === '') continue;
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
		const nextCursor: string | null =
			data.members.length === PAGE_SIZE ? String(nextOffset) : null;

		return { rows, nextCursor, totalEstimate: data.total_items };
	},
};
