/**
 * Route test for `GET /api/app-version`: the build an open tab compares its own
 * with. It answers this server's build id and release version, and is never
 * cached, or a tab would compare against an answer from before the deploy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const headers: Record<string, string> = {};
let runtimeConfig: { app: { buildId?: string }; public: { owlatVersion?: string } };

beforeEach(() => {
	for (const key of Object.keys(headers)) delete headers[key];
	runtimeConfig = { app: { buildId: '3f1c2a' }, public: { owlatVersion: '0.6.17' } };
	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal('useRuntimeConfig', () => runtimeConfig);
	vi.stubGlobal('setHeader', (_event: unknown, name: string, value: string) => {
		headers[name] = value;
	});
	vi.resetModules();
});

afterEach(() => vi.unstubAllGlobals());

async function callRoute(): Promise<unknown> {
	const mod = await import('../app-version.get');
	return (mod.default as unknown as (event: unknown) => unknown)({});
}

describe('GET /api/app-version', () => {
	it('answers the build id and release version this server runs', async () => {
		expect(await callRoute()).toEqual({ buildId: '3f1c2a', version: '0.6.17' });
	});

	it('is never cached', async () => {
		await callRoute();
		expect(headers['cache-control']).toBe('no-store');
	});

	it('answers empty strings rather than failing when a value is missing', async () => {
		runtimeConfig = { app: {}, public: {} };
		expect(await callRoute()).toEqual({ buildId: '', version: '' });
	});
});
