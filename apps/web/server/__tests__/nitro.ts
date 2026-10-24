/**
 * The Nitro auto-imports the server auth gates read (`useRuntimeConfig`,
 * `getHeader`, `createError`), installed as globals the way Nitro provides
 * them. `getHeader` reads the fake event's header map, so a suite states a
 * request's cookie by building the event, not by stubbing the reader.
 */
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import type { H3Event } from 'h3';

export interface HttpError extends Error {
	statusCode: number;
}

export function requestEvent(headers: Record<string, string> = {}): H3Event {
	const lowered = Object.fromEntries(
		Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
	);
	return { headers: lowered } as unknown as H3Event;
}

/**
 * An event carrying `body` as its JSON request body, for a route that reads it
 * through `readJsonBody` (server/utils/jsonBody.ts). `undefined` sends no body;
 * a string is sent as is, so a case can post bytes that are not JSON.
 */
export function jsonRequestEvent(body: unknown, headers: Record<string, string> = {}): H3Event {
	const req = Object.assign(new PassThrough(), { headers: {} });
	req.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
	const res = { setHeader: vi.fn() };
	return Object.assign(requestEvent(headers), { node: { req, res } }) as unknown as H3Event;
}

export function installNitroGlobals(config: { convexUrl?: string; siteUrl?: string } = {}): void {
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: {
			convexUrl: config.convexUrl ?? '',
			siteUrl: config.siteUrl ?? 'https://owlat.example',
		},
	}));
	vi.stubGlobal(
		'getHeader',
		(event: { headers?: Record<string, string> }, name: string) =>
			event.headers?.[name.toLowerCase()]
	);
	vi.stubGlobal('createError', (opts: { statusCode: number; message: string }): HttpError =>
		Object.assign(new Error(opts.message), { statusCode: opts.statusCode })
	);
}
