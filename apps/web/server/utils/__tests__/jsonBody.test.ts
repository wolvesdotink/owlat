/**
 * `readJsonBody`, the server routes' replacement for h3's `readBody<T>()`:
 * the body is read off the Node request under a cap, parsed to `unknown` and
 * checked, and every refusal is an HTTP error thrown before the route acts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { v } from 'convex/values';
import type { H3Event } from 'h3';
import { installNitroGlobals, jsonRequestEvent, type HttpError } from '../../__tests__/nitro';
import { readJsonBody } from '../jsonBody';

const body = v.object({ targetVersion: v.optional(v.string()) });

beforeEach(() => installNitroGlobals());

async function refusal(promise: Promise<unknown>): Promise<HttpError> {
	try {
		await promise;
	} catch (error) {
		return error as HttpError;
	}
	throw new Error('expected a refusal');
}

describe('readJsonBody', () => {
	it('answers the checked body', async () => {
		await expect(readJsonBody(jsonRequestEvent({ targetVersion: '1.2.3' }), body)).resolves.toEqual(
			{
				targetVersion: '1.2.3',
			}
		);
	});

	it('refuses a field of the wrong type with a 400 naming its path', async () => {
		const error = await refusal(readJsonBody(jsonRequestEvent({ targetVersion: 123 }), body));
		expect(error.statusCode).toBe(400);
		expect(error.message).toBe('Invalid request body: $.targetVersion: expected string');
	});

	it("uses the route's own wording for a 400 when it has one", async () => {
		const error = await refusal(
			readJsonBody(jsonRequestEvent('{"targetVersion":'), body, { invalidMessage: 'Bad update' })
		);
		expect(error).toMatchObject({ statusCode: 400, message: 'Bad update' });
	});

	it('reads an absent body as the stand-in the route names', async () => {
		await expect(
			readJsonBody(jsonRequestEvent(undefined), body, { emptyBody: {} })
		).resolves.toEqual({});
	});

	it('refuses a body past the cap with 413 and closes the connection', async () => {
		const req = Object.assign(new PassThrough(), { headers: {} });
		const res = { setHeader: (name: string, value: string) => headers.push([name, value]) };
		const headers: [string, string][] = [];
		req.end(JSON.stringify({ targetVersion: 'x'.repeat(1024 * 1024) }));
		const event = { headers: {}, node: { req, res } } as unknown as H3Event;
		const error = await refusal(readJsonBody(event, body));
		expect(error.statusCode).toBe(413);
		expect(headers).toEqual([['Connection', 'close']]);
	});
});
