/**
 * Stripe integration import provider adapter.
 *
 * Owns the Stripe-side surface of one **Integration import** run —
 * config validation, HTTP fetch, response parsing, and normalization
 * into `ImportRow[]` for the **Contact import (module)**.
 *
 * Cursor convention: empty string is the first-page sentinel; otherwise
 * the cursor is the Stripe customer id passed as `starting_after`.
 * Terminal page returns `nextCursor: null`.
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

interface StripeCustomer {
	id: string;
	email: string | null;
	name: string | null;
	metadata?: Record<string, string>;
}

interface StripeCustomerListResponse {
	data: StripeCustomer[];
	has_more: boolean;
}

export const stripeProvider: IntegrationImportProviderModule<'stripe'> = {
	kind: 'stripe',
	defaultDoiAttest: 'stripe',

	validateConfig(config) {
		if (!config.apiKey) {
			return { ok: false, reason: 'Stripe API key is required' };
		}
		if (!config.apiKey.startsWith('sk_') && !config.apiKey.startsWith('rk_')) {
			return {
				ok: false,
				reason: 'Invalid Stripe API key. Must start with sk_ (secret) or rk_ (restricted)',
			};
		}
		return { ok: true };
	},

	async fetchPage({ config, cursor }): Promise<FetchPageResult> {
		let url = `https://api.stripe.com/v1/customers?limit=${PAGE_SIZE}`;
		if (cursor) {
			url += `&starting_after=${cursor}`;
		}

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'GET',
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
			});
		} catch (err) {
			throw new RetryableProviderError(
				`Network error fetching Stripe page after "${cursor || 'start'}": ${err instanceof Error ? err.message : 'unknown'}`,
			);
		}

		if (response.status === 429) {
			throw new RetryableProviderError(
				`Stripe rate limit (429) after "${cursor || 'start'}"`,
			);
		}
		if (!response.ok) {
			let errorMessage = `Stripe API error: ${response.status}`;
			try {
				const errorData = (await response.json()) as { error?: { message?: string } };
				if (errorData?.error?.message) {
					errorMessage = errorData.error.message;
				}
			} catch {
				// Non-JSON error response — fall through with status-only message.
			}
			throw new Error(errorMessage);
		}

		const data = (await response.json()) as StripeCustomerListResponse;

		// Extract contacts from this page. Stripe's `metadata` is fully
		// arbitrary key-value; we pluck name fields explicitly and pass the
		// rest through as `properties` — the **Contact import (module)** auto-
		// registers unknown property keys on `stripe` source.
		const rows: ImportRow[] = [];
		for (const customer of data.data) {
			if (!customer.email) continue;

			let firstName: string | undefined;
			let lastName: string | undefined;

			if (customer.name) {
				const nameParts = customer.name.trim().split(/\s+/);
				if (nameParts.length >= 2) {
					firstName = nameParts[0];
					lastName = nameParts.slice(1).join(' ');
				} else if (nameParts.length === 1) {
					firstName = nameParts[0];
				}
			}

			// Check metadata for explicit first/last name fields, then fold
			// everything else into `properties`.
			const properties: Record<string, string | number | boolean | null> = {};
			if (customer.metadata) {
				if (customer.metadata['first_name'] || customer.metadata['firstName']) {
					firstName = customer.metadata['first_name'] || customer.metadata['firstName'];
				}
				if (customer.metadata['last_name'] || customer.metadata['lastName']) {
					lastName = customer.metadata['last_name'] || customer.metadata['lastName'];
				}
				for (const [key, value] of Object.entries(customer.metadata)) {
					if (
						key === 'first_name' ||
						key === 'firstName' ||
						key === 'last_name' ||
						key === 'lastName'
					) {
						continue;
					}
					if (value === undefined || value === null || value === '') continue;
					properties[key] = value;
				}
			}

			rows.push({
				email: customer.email.toLowerCase(),
				firstName,
				lastName,
				...(Object.keys(properties).length > 0 ? { properties } : {}),
			});
		}

		const lastCustomer = data.data[data.data.length - 1];
		const nextCursor: string | null =
			data.has_more && lastCustomer ? lastCustomer.id : null;

		// Stripe doesn't expose a total — omit totalEstimate.
		return { rows, nextCursor };
	},
};
