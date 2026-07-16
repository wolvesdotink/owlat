import { describe, it, expect } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import { ByteBudget, collectDataStream, messageTooLargeError } from '../budget.js';

function streamOf(chunks: Buffer[], opts: { sizeExceeded?: boolean } = {}) {
	const s = new PassThrough() as PassThrough & { sizeExceeded?: boolean };
	s.sizeExceeded = opts.sizeExceeded ?? false;
	for (const c of chunks) s.write(c);
	s.end();
	return s;
}

// ---------------------------------------------------------------------------
// Ported verbatim from apps/mta/src/lib/__tests__/dataStream.test.ts — the byte
// budget MUST preserve those exact semantics (D5).
// ---------------------------------------------------------------------------
describe('collectDataStream (ported dataStream semantics)', () => {
	it('collects a message within the budget', async () => {
		const result = await collectDataStream(
			streamOf([Buffer.from('hello '), Buffer.from('world')]),
			1024
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.buffer.toString()).toBe('hello world');
	});

	it('accepts a message exactly at the budget', async () => {
		const result = await collectDataStream(streamOf([Buffer.alloc(10)]), 10);
		expect(result.ok).toBe(true);
	});

	it('rejects once streamed bytes exceed the budget and stops buffering', async () => {
		const result = await collectDataStream(streamOf([Buffer.alloc(8), Buffer.alloc(8)]), 10);
		expect(result.ok).toBe(false);
	});

	it('keeps memory bounded while draining an oversized message', async () => {
		const chunks = Array.from({ length: 30 }, () => Buffer.alloc(1024, 1));
		const result = await collectDataStream(streamOf(chunks), 1024, 100);
		expect(result.ok).toBe(false);
	});

	it('destroys the stream past the abort factor', async () => {
		const s = new PassThrough() as PassThrough & { sizeExceeded?: boolean };
		let destroyed = false;
		const origDestroy = s.destroy.bind(s);
		s.destroy = ((err?: Error) => {
			destroyed = true;
			return origDestroy(err);
		}) as typeof s.destroy;

		const writer = (async () => {
			for (let i = 0; i < 100 && !destroyed; i++) {
				if (!s.write(Buffer.alloc(1024, 1))) {
					await new Promise((r) => s.once('drain', r));
				}
				await new Promise((r) => setImmediate(r));
			}
			if (!destroyed) s.end();
		})();

		const result = await collectDataStream(s, 1024, 4);
		await writer;
		expect(result.ok).toBe(false);
		expect(destroyed).toBe(true);
	});

	it('honors smtp-server sizeExceeded even when bytes fit the budget', async () => {
		const result = await collectDataStream(
			streamOf([Buffer.from('small')], { sizeExceeded: true }),
			1024
		);
		expect(result.ok).toBe(false);
	});
});

describe('messageTooLargeError', () => {
	it('carries SMTP 552 and the limit in MB', () => {
		const err = messageTooLargeError(10 * 1024 * 1024);
		expect(err.responseCode).toBe(552);
		expect(err.message).toContain('10MB');
	});
});

// ---------------------------------------------------------------------------
// ByteBudget unit behavior — the shared policy core.
// ---------------------------------------------------------------------------
describe('ByteBudget', () => {
	it('buffers within budget and returns the concatenation', () => {
		const b = new ByteBudget(10);
		expect(b.push(Buffer.from('abc'))).toBe('ok');
		expect(b.push(Buffer.from('def'))).toBe('ok');
		expect(b.isExceeded).toBe(false);
		expect(b.result().toString()).toBe('abcdef');
		expect(b.total).toBe(6);
	});

	it('accepts a push that lands exactly on the budget', () => {
		const b = new ByteBudget(4);
		expect(b.push(Buffer.alloc(4))).toBe('ok');
		expect(b.isExceeded).toBe(false);
	});

	it('flips to over and discards the buffer once the budget is crossed', () => {
		const b = new ByteBudget(4);
		expect(b.push(Buffer.alloc(3))).toBe('ok');
		expect(b.push(Buffer.alloc(3))).toBe('over');
		expect(b.isExceeded).toBe(true);
		expect(b.result().length).toBe(0);
	});

	it('stays in over (draining) until the abort ceiling', () => {
		const b = new ByteBudget(4, 4); // abort at 16 bytes
		expect(b.push(Buffer.alloc(4))).toBe('ok');
		expect(b.push(Buffer.alloc(4))).toBe('over'); // total 8
		expect(b.push(Buffer.alloc(4))).toBe('over'); // total 12
		expect(b.push(Buffer.alloc(4))).toBe('over'); // total 16 == ceiling, not > it
		expect(b.push(Buffer.alloc(1))).toBe('abort'); // total 17 > 16
	});
});

// ---------------------------------------------------------------------------
// Slowloris / drip: bytes arriving slowly must not defeat the budget. Memory
// stays bounded and the oversize verdict is still produced.
// ---------------------------------------------------------------------------
describe('collectDataStream slowloris / drip', () => {
	it('bounds memory when an oversized message dribbles in one byte at a time', async () => {
		// A generator that yields 1 byte per tick, well past the budget.
		async function* drip(): AsyncGenerator<Buffer> {
			for (let i = 0; i < 200; i++) {
				await new Promise((r) => setImmediate(r));
				yield Buffer.from([0x41]);
			}
		}
		const stream = Readable.from(drip()) as Readable & { sizeExceeded?: boolean };
		const result = await collectDataStream(stream, 16, 4); // abort at 64 bytes
		expect(result.ok).toBe(false);
	});

	it('still collects a small message that dribbles in slowly', async () => {
		async function* drip(): AsyncGenerator<Buffer> {
			for (const ch of ['he', 'll', 'o']) {
				await new Promise((r) => setImmediate(r));
				yield Buffer.from(ch);
			}
		}
		const stream = Readable.from(drip()) as Readable & { sizeExceeded?: boolean };
		const result = await collectDataStream(stream, 1024);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.buffer.toString()).toBe('hello');
	});
});
