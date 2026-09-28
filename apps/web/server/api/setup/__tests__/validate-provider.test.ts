import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installNitroGlobals, requestEvent } from '../../../utils/__tests__/nitro';

/**
 * `POST /api/setup/validate-provider` keeps its own gate (setup mode plus the
 * setup token) and splits its dispatch: a send provider with a catalog
 * `setupProbe` goes through the shared probe helper, everything else through
 * `validateProvider`, after the shared apiKey check.
 */

const { mocks } = vi.hoisted(() => ({
	mocks: {
		validateResendKey: vi.fn(),
		validateEmailitKey: vi.fn(),
		validateSmtpRelay: vi.fn(),
		validateProvider: vi.fn(),
	},
}));

vi.mock('@owlat/shared/setupValidators', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	...mocks,
}));

let body: unknown;
const requireSetupToken = vi.fn();

async function callRoute(): Promise<{ ok: boolean; message: string }> {
	const mod = await import('../validate-provider.post');
	const handler = mod.default as unknown as (
		event: unknown
	) => Promise<{ ok: boolean; message: string }>;
	return handler(requestEvent());
}

beforeEach(() => {
	process.env['OWLAT_SETUP_MODE'] = 'true';
	body = undefined;
	installNitroGlobals();
	requireSetupToken.mockReset();
	vi.stubGlobal('requireSetupToken', requireSetupToken);
	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal(
		'readBody',
		vi.fn(async () => body)
	);
	for (const [name, mock] of Object.entries(mocks)) {
		mock.mockReset().mockResolvedValue({ ok: true, message: `ran ${name}` });
	}
});

describe('POST /api/setup/validate-provider', () => {
	it('refuses outside setup mode before reading the body', async () => {
		process.env['OWLAT_SETUP_MODE'] = 'false';
		await expect(callRoute()).rejects.toMatchObject({ statusCode: 403 });
		expect(requireSetupToken).not.toHaveBeenCalled();
	});

	it('refuses a bad setup token before any probe', async () => {
		requireSetupToken.mockImplementation(() => {
			throw Object.assign(new Error('Invalid'), { statusCode: 401 });
		});
		body = { provider: 'resend', apiKey: 'key' };
		await expect(callRoute()).rejects.toMatchObject({ statusCode: 401 });
		for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
	});

	it('sends a catalog-probed kind through its declared validator', async () => {
		body = { provider: 'smtp', smtp: { host: 'smtp.owlat.example', username: 'u', password: 'p' } };
		await expect(callRoute()).resolves.toEqual({ ok: true, message: 'ran validateSmtpRelay' });
		expect(mocks.validateSmtpRelay).toHaveBeenCalledWith({
			host: 'smtp.owlat.example',
			port: 587,
			secure: false,
			username: 'u',
			password: 'p',
		});
		expect(mocks.validateProvider).not.toHaveBeenCalled();
	});

	it('sends a non-send provider through validateProvider with its host', async () => {
		body = { provider: 'posthog', apiKey: 'key', host: 'https://ph.owlat.example' };
		await expect(callRoute()).resolves.toEqual({ ok: true, message: 'ran validateProvider' });
		expect(mocks.validateProvider).toHaveBeenCalledWith(
			'posthog',
			'key',
			'https://ph.owlat.example'
		);
	});

	it('still requires an apiKey for a non-send provider', async () => {
		body = { provider: 'openai' };
		await expect(callRoute()).rejects.toMatchObject({
			statusCode: 400,
			message: 'apiKey is required.',
		});
		expect(mocks.validateProvider).not.toHaveBeenCalled();
	});

	it('answers 400 without a provider', async () => {
		body = {};
		await expect(callRoute()).rejects.toMatchObject({
			statusCode: 400,
			message: 'provider is required.',
		});
	});
});
