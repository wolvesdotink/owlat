import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters as stripAnsi } from 'node:util';

const spin = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }));

vi.mock('@clack/prompts', () => ({
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
	spinner: vi.fn(() => spin),
}));

import { log } from '@clack/prompts';
import {
	backendErrorMessage,
	loadBackendContext,
	postWithSpinner,
	resolveSiteUrl,
	type BackendContext,
} from '../backend';

/**
 * What the CLI prints when the backend refuses.
 *
 * The `/seed/*`, `/dev/*` and `/sample-data/*` endpoints answer in the locked
 * `{ error: { category, message } }` envelope (ADR-0036), but the CLI ships
 * separately from the container it talks to, so the older `{ error: "…" }`
 * string must keep reading as a message rather than as `[object Object]`.
 */
describe('backendErrorMessage', () => {
	it('reads the message out of the error envelope', () => {
		expect(
			backendErrorMessage({ error: { category: 'unauthenticated', message: 'Unauthorized' } }, 'x')
		).toBe('Unauthorized');
	});

	it('still reads the older string form', () => {
		expect(backendErrorMessage({ error: 'Unauthorized' }, 'x')).toBe('Unauthorized');
	});

	it('falls back when the body carries no usable message', () => {
		expect(backendErrorMessage({}, 'HTTP 500')).toBe('HTTP 500');
		expect(backendErrorMessage({ error: {} }, 'HTTP 500')).toBe('HTTP 500');
		expect(backendErrorMessage({ error: '' }, 'HTTP 500')).toBe('HTTP 500');
		expect(backendErrorMessage(null, 'HTTP 500')).toBe('HTTP 500');
		expect(backendErrorMessage('nope', 'HTTP 500')).toBe('HTTP 500');
	});
});

describe('postWithSpinner', () => {
	const ctx: BackendContext = {
		baseUrl: 'http://localhost:3211',
		instanceSecret: 'secret',
		siteUrl: 'http://localhost:3000',
	};

	function stubFetch(impl: () => Promise<Response>) {
		const fetchMock = vi.fn<(url: string) => Promise<Response>>(impl);
		vi.stubGlobal('fetch', fetchMock);
		return fetchMock;
	}

	const lastStop = () => stripAnsi(String(spin.stop.mock.calls.at(-1)?.[0]));

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv('OWLAT_PROGRESS', '');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it('reports a transport error and points at the docker stack', async () => {
		stubFetch(async () => {
			throw new Error('connect ECONNREFUSED');
		});

		const result = await postWithSpinner(ctx, { path: '/seed/demo' });

		expect(result).toBeNull();
		expect(lastStop()).toBe('Failed: connect ECONNREFUSED');
		expect(log.error).toHaveBeenCalledWith(
			'Is the docker stack up? Try `docker compose up -d` first.'
		);
	});

	it('prints the backend message and the 404 hint for a missing route', async () => {
		stubFetch(
			async () =>
				new Response(JSON.stringify({ error: { category: 'not_found', message: 'No route' } }), {
					status: 404,
				})
		);

		const result = await postWithSpinner(
			ctx,
			{ path: '/sample-data/status' },
			{ notFoundHint: 'deploy the current functions' }
		);

		expect(result).toBeNull();
		expect(lastStop()).toBe('Failed: No route');
		expect(log.error).toHaveBeenCalledWith('deploy the current functions');
	});

	it('does not print the 404 hint for other failures', async () => {
		stubFetch(async () => new Response('{}', { status: 500 }));

		const result = await postWithSpinner(ctx, { path: '/x' }, { notFoundHint: 'hint' });

		expect(result).toBeNull();
		expect(lastStop()).toBe('Failed: HTTP 500');
		expect(log.error).not.toHaveBeenCalled();
	});

	it('passes an OK status through with the parsed body', async () => {
		const fetchMock = stubFetch(
			async () => new Response(JSON.stringify({ inserted: { contacts: 3 } }), { status: 200 })
		);

		const result = await postWithSpinner(
			ctx,
			{ path: '/seed/demo', searchParams: { reset: 'true' } },
			{ label: 'Seeding' }
		);

		expect(result).toEqual({ status: 200, body: { inserted: { contacts: 3 } } });
		expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:3211/seed/demo?reset=true');
		expect(stripAnsi(String(spin.start.mock.calls[0]![0]))).toBe(
			'Seeding — POST http://localhost:3211/seed/demo?reset=true'
		);
		expect(lastStop()).toBe('Done');
	});

	it('treats caller-listed statuses as success and lets the caller word the stop line', async () => {
		stubFetch(async () => new Response('{}', { status: 409 }));

		const result = await postWithSpinner(
			ctx,
			{ path: '/seed/admin', body: {} },
			{
				okStatuses: [201, 409],
				stopMessage: (status) => (status === 201 ? 'created' : 'exists'),
			}
		);

		expect(result?.status).toBe(409);
		expect(lastStop()).toBe('exists');
		expect(log.error).not.toHaveBeenCalled();
	});
});

describe('site URL for the success messages', () => {
	it('prefers SITE_URL, then NUXT_PUBLIC_SITE_URL, then local dev', () => {
		expect(
			resolveSiteUrl({
				SITE_URL: 'https://mail.example.com',
				NUXT_PUBLIC_SITE_URL: 'https://other.example.com',
			})
		).toBe('https://mail.example.com');
		expect(resolveSiteUrl({ NUXT_PUBLIC_SITE_URL: 'https://other.example.com' })).toBe(
			'https://other.example.com'
		);
		expect(resolveSiteUrl({ SITE_URL: '' })).toBe('http://localhost:3000');
		expect(resolveSiteUrl({})).toBe('http://localhost:3000');
	});

	it('loadBackendContext carries it from the .env', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'owlat-backend-'));
		try {
			writeFileSync(join(dir, '.env'), 'INSTANCE_SECRET=abc\nSITE_URL=https://mail.example.com\n');
			const ctx = await loadBackendContext(dir);
			expect(ctx.siteUrl).toBe('https://mail.example.com');
			expect(ctx.baseUrl).toBe('http://localhost:3211');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
