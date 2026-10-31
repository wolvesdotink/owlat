import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as SetupValidationHttp from '../setupValidationHttp';
import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	type CoreSendProviderCatalogEntry,
} from '../sendProviderCatalog';

/**
 * `validateProvider` runs a send-provider kind's API-key probe by the validator
 * name its catalog `setupProbe` declares, and names no kind itself. The request
 * each probe sends is recorded, so a kind routed to the wrong vendor's validator
 * fails here.
 */

const fetchProviderMock = vi.fn(
	async (_url: string, _init: RequestInit) => new Response(null, { status: 200 })
);
vi.mock('../setupValidationHttp', async (importOriginal) => {
	const actual = await importOriginal<typeof SetupValidationHttp>();
	return {
		...actual,
		fetchSetupProvider: (url: string, init: RequestInit) => fetchProviderMock(url, init),
	};
});

import { validateProvider, type SetupProvider } from '../setupValidators';

function requestedUrl(): string {
	return String(fetchProviderMock.mock.calls[0]?.[0]);
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('validateProvider — send-provider kinds', () => {
	it.each([
		['resend', 'https://api.resend.com/domains', 'Resend key accepted.'],
		['emailit', 'https://api.emailit.com/v2/domains', 'Emailit key accepted.'],
	] as const)('%s runs its catalog probe', async (kind, url, message) => {
		await expect(validateProvider(kind, 'key')).resolves.toEqual({ ok: true, message });
		expect(fetchProviderMock).toHaveBeenCalledTimes(1);
		expect(requestedUrl()).toBe(url);
	});

	it('dispatches every API-key probe the catalog declares', async () => {
		const entries: readonly CoreSendProviderCatalogEntry[] = CORE_SEND_PROVIDER_CATALOG_ENTRIES;
		const kinds = entries
			.filter((entry) => entry.setupProbe && entry.setupProbe.validator !== 'validateSmtpRelay')
			.map((entry) => entry.kind);
		expect(kinds.length).toBeGreaterThan(0);
		for (const kind of kinds) {
			fetchProviderMock.mockClear();
			const result = await validateProvider(kind as SetupProvider, 'key');
			expect(result.ok, kind).toBe(true);
			expect(fetchProviderMock, kind).toHaveBeenCalledTimes(1);
		}
	});

	it('refuses a kind whose probe needs more than a key, without a request', async () => {
		await expect(validateProvider('smtp' as SetupProvider, 'key')).resolves.toEqual({
			ok: false,
			message: 'Unknown provider: smtp',
		});
		expect(fetchProviderMock).not.toHaveBeenCalled();
	});

	it('refuses a kind with no probe', async () => {
		await expect(validateProvider('ses' as SetupProvider, 'key')).resolves.toEqual({
			ok: false,
			message: 'Unknown provider: ses',
		});
		expect(fetchProviderMock).not.toHaveBeenCalled();
	});
});

describe('validateProvider — the other setup keys', () => {
	it('still routes the AI keys by name', async () => {
		await expect(validateProvider('openai', 'key')).resolves.toEqual({
			ok: true,
			message: 'OpenAI key accepted.',
		});
		expect(requestedUrl()).toBe('https://api.openai.com/v1/models');
	});

	it('refuses an unknown provider', async () => {
		await expect(validateProvider('nope' as SetupProvider, 'key')).resolves.toEqual({
			ok: false,
			message: 'Unknown provider: nope',
		});
	});
});
