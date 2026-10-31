import { describe, it, expect, vi } from 'vitest';
import type { CoreSendProviderCatalogEntry } from '@owlat/shared/sendProviderCatalog';
import type * as SetupSendingConfig from '@owlat/shared/setupSendingConfig';

/**
 * A kind the CLI has never heard of is still set up: the picker offers it under
 * its catalog label, prompts its required fields with the control each field
 * kind calls for, and writes the env variables they name. This is what "the CLI
 * reads the catalog" buys a new provider — no edit in apps/setup-cli.
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
					default: 'eu',
					required: true,
				},
				{ kind: 'boolean', key: 'sandbox', label: 'k', envVar: 'ACME_SANDBOX', required: true },
				{ kind: 'number', key: 'pool', label: 'k', envVar: 'ACME_POOL', required: true },
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

const calls = vi.hoisted(() => [] as { prompt: string; message: string; [k: string]: unknown }[]);

vi.mock('@clack/prompts', () => {
	const answers: Record<string, unknown> = {
		'Email sending provider': 'acme',
		'Acme Mail ACME_API_KEY': 'ak_live',
		'Acme Mail ACME_ZONE': 'us',
		'Acme Mail ACME_SANDBOX': true,
		'Acme Mail ACME_POOL': ' 3 ',
	};
	const prompt =
		(kind: string) =>
		async (options: { message: string }): Promise<unknown> => {
			calls.push({ prompt: kind, ...options });
			return answers[options.message];
		};
	return {
		select: prompt('select'),
		password: prompt('password'),
		text: prompt('text'),
		confirm: prompt('confirm'),
		isCancel: () => false,
	};
});

vi.mock('../../lib/progress', () => ({ validateWithSpinner: vi.fn() }));

import { pickSendingProvider } from '../setupSendingProvider';

describe('pickSendingProvider — a kind outside the shipped set', () => {
	it('prompts its required fields by field kind and writes their env variables', async () => {
		await expect(pickSendingProvider()).resolves.toEqual({
			EMAIL_PROVIDER: 'acme',
			ACME_API_KEY: 'ak_live',
			ACME_ZONE: 'us',
			ACME_SANDBOX: 'true',
			ACME_POOL: '3',
		});
		expect(calls[0]?.['options']).toContainEqual({ value: 'acme', label: 'Acme Mail' });
		expect(calls.slice(1).map((c) => [c.prompt, c.message])).toEqual([
			['password', 'Acme Mail ACME_API_KEY'],
			['select', 'Acme Mail ACME_ZONE'],
			['confirm', 'Acme Mail ACME_SANDBOX'],
			['text', 'Acme Mail ACME_POOL'],
		]);
		const zone = calls.find((c) => c.message === 'Acme Mail ACME_ZONE');
		expect(zone).toMatchObject({
			initialValue: 'eu',
			options: [
				{ value: 'eu', label: 'eu' },
				{ value: 'us', label: 'us' },
			],
		});
		const pool = calls.find((c) => c.message === 'Acme Mail ACME_POOL') as unknown as {
			validate: (v: string) => string | undefined;
		};
		expect(pool.validate('x')).toBe('Enter a number.');
		expect(pool.validate('')).toBe('Acme Mail ACME_POOL is required.');
		expect(pool.validate('4')).toBeUndefined();
	});
});
