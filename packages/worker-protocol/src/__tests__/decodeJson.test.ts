/**
 * `decodeJson` — the one bounded read, parse and check every HTTP ingress runs
 * a JSON body through. The cases are the ones a `req.json<T>()` cast waved
 * through: wrong roots, wrong field types, bad nested elements, bodies past
 * the cap whatever their headers claim, and streams that fail mid-read.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { v } from 'convex/values';
import {
	decodeJson,
	decodeJsonText,
	decodeJsonValue,
	guardDecoder,
	nodeRequestSource,
	parserDecoder,
	validatorDecoder,
	type JsonBodySource,
} from '../decodeJson';

const sendBody = v.object({
	from: v.string(),
	recipients: v.array(v.string()),
	note: v.optional(v.string()),
});

const encoder = new TextEncoder();

/** A source whose stream yields `chunks` in order; records reads and cancels. */
function source(
	chunks: (string | Uint8Array)[],
	headers: Record<string, string> = {},
	failAfter?: number
): JsonBodySource & { pulls: number; cancelled: boolean } {
	const queue = chunks.map((chunk) => (typeof chunk === 'string' ? encoder.encode(chunk) : chunk));
	const state = {
		pulls: 0,
		cancelled: false,
		headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
		body: null as ReadableStream<Uint8Array> | null,
	};
	state.body = new ReadableStream<Uint8Array>({
		pull(controller) {
			state.pulls += 1;
			if (failAfter !== undefined && state.pulls > failAfter) {
				controller.error(new Error('connection reset'));
				return;
			}
			const next = queue.shift();
			if (next === undefined) controller.close();
			else controller.enqueue(next);
		},
		cancel() {
			state.cancelled = true;
		},
	});
	return state;
}

const json = (value: unknown, headers?: Record<string, string>) =>
	source([JSON.stringify(value)], headers);

describe('decodeJson: shape', () => {
	it('answers the parsed value when it matches', async () => {
		const result = await decodeJson(
			json({ from: 'a@example.com', recipients: ['b@example.com'] }),
			sendBody,
			1024
		);
		expect(result).toEqual({
			ok: true,
			value: { from: 'a@example.com', recipients: ['b@example.com'] },
		});
	});

	it.each([
		['null', null, '$: expected object'],
		['an array', [], '$: expected object'],
		['a string', 'x', '$: expected object'],
		['a number', 7, '$: expected object'],
	])('refuses %s as the root', async (_name, value, issue) => {
		const result = await decodeJson(json(value), sendBody, 1024);
		expect(result).toEqual({
			ok: false,
			failure: { kind: 'invalid', status: 400, message: `Invalid request body: ${issue}`, issue },
		});
	});

	it('refuses a missing required field', async () => {
		const result = await decodeJson(json({ from: 'a@example.com' }), sendBody, 1024);
		expect(result).toMatchObject({ ok: false, failure: { issue: '$.recipients: missing' } });
	});

	it('refuses a wrong primitive and a bad nested element, by path only', async () => {
		const wrong = await decodeJson(json({ from: 42, recipients: [] }), sendBody, 1024);
		expect(wrong.ok || wrong.failure).toMatchObject({ issue: '$.from: expected string' });
		const nested = await decodeJson(
			json({ from: 'a@example.com', recipients: ['b@example.com', 9] }),
			sendBody,
			1024
		);
		expect(nested.ok || nested.failure).toMatchObject({
			issue: '$.recipients[1]: expected string',
		});
		// The message names the place, never the value found there.
		expect(JSON.stringify(nested)).not.toContain('9]');
	});

	it('keeps unknown keys an older build has never heard of, and returns them untouched', async () => {
		const body = { from: 'a@example.com', recipients: [], addedNextRelease: { x: 1 } };
		const result = await decodeJson(json(body), sendBody, 1024);
		expect(result).toEqual({ ok: true, value: body });
	});

	it('refuses unknown keys only when the route asks for an exact protocol', async () => {
		const exact = validatorDecoder(sendBody, 'reject');
		const result = await decodeJson(
			json({ from: 'a@example.com', recipients: [], extra: true }),
			exact,
			1024
		);
		expect(result).toMatchObject({ ok: false, failure: { issue: '$: unexpected field' } });
	});

	it('keeps an own __proto__ key as data, not as a prototype', async () => {
		const result = await decodeJson(
			source(['{"from":"a@example.com","recipients":[],"__proto__":{"polluted":true}}']),
			sendBody,
			1024
		);
		expect(result.ok).toBe(true);
		expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
	});
});

describe('decodeJson: syntax and emptiness', () => {
	it('refuses malformed JSON', async () => {
		const result = await decodeJson(source(['{"from":']), sendBody, 1024);
		expect(result).toEqual({
			ok: false,
			failure: { kind: 'malformed', status: 400, message: 'Request body is not valid JSON' },
		});
	});

	it('refuses bytes that are not UTF-8', async () => {
		const result = await decodeJson(source([new Uint8Array([0x7b, 0xff, 0x7d])]), v.any(), 1024);
		expect(result.ok || result.failure.kind).toBe('malformed');
	});

	it('refuses an empty or whitespace body unless the route names what it stands for', async () => {
		for (const body of [[], [''], ['  \n ']]) {
			const result = await decodeJson(source(body), v.object({}), 1024);
			expect(result.ok || result.failure.kind).toBe('empty');
		}
		const legacy = await decodeJson(
			source([]),
			v.object({ force: v.optional(v.boolean()) }),
			1024,
			{ emptyBody: {} }
		);
		expect(legacy).toEqual({ ok: true, value: {} });
	});

	it('still refuses a malformed non-empty body on a route that allows an empty one', async () => {
		const result = await decodeJson(source(['not json']), v.object({}), 1024, { emptyBody: {} });
		expect(result.ok || result.failure.kind).toBe('malformed');
	});

	it('runs the empty-body stand-in through the decoder too', async () => {
		const result = await decodeJson(source([]), sendBody, 1024, { emptyBody: {} });
		expect(result).toMatchObject({ ok: false, failure: { issue: '$.from: missing' } });
	});

	it('reads a request with no body stream as empty', async () => {
		const result = await decodeJson(
			{ body: null, headers: { get: () => null } },
			v.object({}),
			1024,
			{ emptyBody: {} }
		);
		expect(result).toEqual({ ok: true, value: {} });
	});
});

describe('decodeJson: the byte cap is on real streamed octets', () => {
	// 'é' is two UTF-8 bytes: a string-length check would count one.
	const body = JSON.stringify({ note: 'é'.repeat(10) });
	const bytes = encoder.encode(body).byteLength;
	const noteOnly = v.object({ note: v.string() });

	it('accepts a body of exactly the cap, split across chunks mid-character', async () => {
		const raw = encoder.encode(body);
		const split = raw.indexOf(0xc3) + 1;
		const result = await decodeJson(
			source([raw.subarray(0, split), raw.subarray(split)]),
			noteOnly,
			bytes
		);
		expect(result).toEqual({ ok: true, value: { note: 'é'.repeat(10) } });
	});

	it('refuses one byte past the cap, with no Content-Length, and stops reading', async () => {
		const stream = source([body, ' ', 'never read']);
		const result = await decodeJson(stream, noteOnly, bytes);
		expect(result).toEqual({
			ok: false,
			failure: { kind: 'too_large', status: 413, message: 'Request body too large' },
		});
		expect(stream.cancelled).toBe(true);
		expect(stream.pulls).toBe(2);
	});

	it('refuses a declared length past the cap before reading anything', async () => {
		const stream = source([body], { 'content-length': String(bytes + 1) });
		const result = await decodeJson(stream, noteOnly, bytes);
		expect(result.ok || result.failure.kind).toBe('too_large');
		expect(stream.pulls).toBe(0);
		expect(stream.cancelled).toBe(true);
	});

	it('does not trust an understated Content-Length', async () => {
		const stream = source([body, ' '], { 'content-length': '2' });
		const result = await decodeJson(stream, noteOnly, bytes);
		expect(result.ok || result.failure.kind).toBe('too_large');
	});

	it('ignores a Content-Length that states no length', async () => {
		const result = await decodeJson(source([body], { 'content-length': 'abc' }), noteOnly, bytes);
		expect(result.ok).toBe(true);
	});

	it('treats an absurd declared length as past any cap', async () => {
		const result = await decodeJson(
			source([body], { 'content-length': '9'.repeat(40) }),
			noteOnly,
			bytes
		);
		expect(result.ok || result.failure.kind).toBe('too_large');
	});

	it('refuses an invalid cap rather than reading unbounded', async () => {
		await expect(decodeJson(source([body]), noteOnly, Number.NaN)).rejects.toThrow(RangeError);
	});
});

describe('decodeJson: a stream that fails', () => {
	it('answers unreadable when the producer errors mid-body', async () => {
		const result = await decodeJson(source(['{"note":', '"x"}'], {}, 1), v.any(), 1024);
		expect(result).toEqual({
			ok: false,
			failure: { kind: 'unreadable', status: 400, message: 'Request body could not be read' },
		});
	});

	it('answers unreadable for a body something else already consumed', async () => {
		const request = new Request('https://owlat.example/send', { method: 'POST', body: '{}' });
		await request.text();
		const result = await decodeJson(request, v.any(), 1024);
		expect(result.ok || result.failure.kind).toBe('unreadable');
	});

	it('reads a fetch Request directly', async () => {
		const request = new Request('https://owlat.example/send', {
			method: 'POST',
			body: JSON.stringify({ from: 'a@example.com', recipients: [] }),
		});
		const result = await decodeJson(request, sendBody, 1024);
		expect(result.ok).toBe(true);
	});
});

describe('decoders', () => {
	it('adapts a guard a route already owns', () => {
		const isPing = (value: unknown): value is { ping: true } =>
			typeof value === 'object' && value !== null && (value as { ping?: unknown }).ping === true;
		expect(decodeJsonText('{"ping":true}', guardDecoder(isPing))).toEqual({
			ok: true,
			value: { ping: true },
		});
		const refused = decodeJsonText('{"ping":1}', guardDecoder(isPing, '$: not a ping'));
		expect(refused.ok || refused.failure.message).toBe('Invalid request body: $: not a ping');
	});

	it('adapts a parse function and returns ITS value', () => {
		const parse = (value: unknown) => (typeof value === 'string' ? value.trim() : null);
		expect(decodeJsonValue(' x ', parserDecoder(parse))).toEqual({ ok: true, value: 'x' });
		expect(decodeJsonValue(1, parserDecoder(parse)).ok).toBe(false);
	});

	it('checks a value a framework already parsed', () => {
		expect(decodeJsonValue({ from: 'a', recipients: [1] }, sendBody)).toMatchObject({
			ok: false,
			failure: { issue: '$.recipients[0]: expected string' },
		});
	});
});

describe('nodeRequestSource', () => {
	function nodeRequest(headers: Record<string, string> = {}) {
		return Object.assign(new PassThrough(), { headers });
	}

	it('reads a Node request body', async () => {
		const req = nodeRequest();
		req.end(JSON.stringify({ from: 'a@example.com', recipients: ['b@example.com'] }));
		const result = await decodeJson(nodeRequestSource(req), sendBody, 1024);
		expect(result.ok).toBe(true);
	});

	it('stops buffering past the cap and drains the rest instead of destroying the request', async () => {
		const req = nodeRequest();
		const source = nodeRequestSource(req);
		req.write('{"note":"');
		req.write('x'.repeat(64));
		const result = await decodeJson(source, v.any(), 16);
		expect(result.ok || result.failure.kind).toBe('too_large');
		// The producer can keep writing: the rest is discarded, the request lives on
		// for the transport to answer on.
		const errors: unknown[] = [];
		req.on('error', (error) => errors.push(error));
		req.end('"}');
		await new Promise((resolve) => req.once('end', resolve));
		expect(req.readableEnded).toBe(true);
		expect(errors).toEqual([]);
	});

	it('refuses a declared length past the cap without reading', async () => {
		const req = nodeRequest({ 'content-length': '100' });
		const result = await decodeJson(nodeRequestSource(req), v.any(), 16);
		expect(result.ok || result.failure.kind).toBe('too_large');
		expect(req.destroyed).toBe(false);
	});

	it('answers unreadable when the request errors mid-body', async () => {
		const req = nodeRequest();
		const source = nodeRequestSource(req);
		req.write('{"note":');
		const pending = decodeJson(source, v.any(), 1024);
		req.destroy(new Error('socket hang up'));
		const result = await pending;
		expect(result.ok || result.failure.kind).toBe('unreadable');
	});

	it('reads a request that has already ended as empty, instead of waiting forever', async () => {
		const req = nodeRequest();
		req.end();
		req.resume();
		await new Promise((resolve) => req.once('end', resolve));
		const result = await decodeJson(nodeRequestSource(req), v.object({}), 1024, {
			emptyBody: {},
		});
		expect(result).toEqual({ ok: true, value: {} });
	});
});
