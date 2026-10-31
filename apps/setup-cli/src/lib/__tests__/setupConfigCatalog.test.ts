import { describe, it, expect, vi } from 'vitest';
import type { CoreSendProviderCatalogEntry } from '@owlat/shared/sendProviderCatalog';
import type * as SetupSendingConfig from '@owlat/shared/setupSendingConfig';

/**
 * The config parser checks a `sending` block by the field kinds its catalog
 * entry declares, so a kind outside the shipped set is validated with no edit
 * here. The synthetic entry uses the field kinds no shipped kind requires.
 */

const ACME = vi.hoisted(
	() =>
		({
			kind: 'acme',
			label: 'Acme Mail',
			credentialFields: [
				{ kind: 'secret', key: 'apiKey', label: 'k', envVar: 'ACME_API_KEY', required: true },
				{
					kind: 'select',
					key: 'zone',
					label: 'k',
					envVar: 'ACME_ZONE',
					options: [
						{ value: 'eu', label: 'k' },
						{ value: 'us', label: 'k' },
					],
					required: true,
				},
				{ kind: 'boolean', key: 'sandbox', label: 'k', envVar: 'ACME_SANDBOX' },
				{ kind: 'number', key: 'pool', label: 'k', envVar: 'ACME_POOL' },
				{ kind: 'string', key: 'tag', label: 'k', envVar: 'ACME_TAG' },
			],
		}) as unknown as CoreSendProviderCatalogEntry
);

vi.mock('@owlat/shared/setupSendingConfig', async (importOriginal) => {
	const actual = await importOriginal<typeof SetupSendingConfig>();
	return {
		...actual,
		SETUP_SENDING_CATALOG_ENTRIES: [...actual.SETUP_SENDING_CATALOG_ENTRIES, ACME],
	};
});

import { parseSetupConfig } from '../setupConfig';

function withSending(sending: Record<string, unknown>): Record<string, unknown> {
	return {
		version: 1,
		deploymentMode: 'selfhost',
		features: {},
		sending: { provider: 'acme', ...sending },
		admin: { email: 'admin@example.com', name: 'Admin', password: 'longenoughpw!' },
	};
}

describe('parseSetupConfig — a kind outside the shipped set', () => {
	it('accepts the values its fields declare', () => {
		const sending = { apiKey: 'k', zone: 'us', sandbox: true, pool: 3, tag: 'x' };
		expect(parseSetupConfig(withSending(sending)).sending).toEqual({
			provider: 'acme',
			...sending,
		});
		expect(() => parseSetupConfig(withSending({ apiKey: 'k', zone: 'eu' }))).not.toThrow();
	});

	it.each([
		[
			'a missing required secret',
			{ zone: 'eu' },
			'config.sending.apiKey must be a non-empty string',
		],
		['a missing required select', { apiKey: 'k' }, 'config.sending.zone must be one of eu, us'],
		[
			'an undeclared option',
			{ apiKey: 'k', zone: 'ap' },
			'config.sending.zone must be one of eu, us',
		],
		[
			'a non-boolean toggle',
			{ apiKey: 'k', zone: 'eu', sandbox: 'yes' },
			'config.sending.sandbox must be a boolean',
		],
		[
			'a non-numeric number',
			{ apiKey: 'k', zone: 'eu', pool: '3' },
			'config.sending.pool must be a number',
		],
		[
			'an empty optional string',
			{ apiKey: 'k', zone: 'eu', tag: '' },
			'config.sending.tag must be a non-empty string',
		],
	])('refuses %s', (_label, sending, message) => {
		expect(() => parseSetupConfig(withSending(sending))).toThrow(message);
	});

	it('names the extra kind among the ones a config can carry', () => {
		expect(() => parseSetupConfig(withSending({ provider: 'nope' }))).toThrow(
			'config.sending.provider must be one of mta, ses, resend, smtp, emailit, acme'
		);
	});
});
