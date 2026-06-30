import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { collectDataStream, messageTooLargeError } from '../dataStream.js';

function streamOf(chunks: Buffer[], opts: { sizeExceeded?: boolean } = {}) {
	const s = new PassThrough() as PassThrough & { sizeExceeded?: boolean };
	s.sizeExceeded = opts.sizeExceeded ?? false;
	for (const c of chunks) s.write(c);
	s.end();
	return s;
}

describe('collectDataStream', () => {
	it('collects a message within the budget', async () => {
		const result = await collectDataStream(streamOf([Buffer.from('hello '), Buffer.from('world')]), 1024);
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
		// 30 chunks × 1KB against a 1KB budget — the drain path must not
		// accumulate chunks after the budget is crossed.
		const chunks = Array.from({ length: 30 }, () => Buffer.alloc(1024, 1));
		const s = streamOf(chunks);
		const result = await collectDataStream(s, 1024, 100); // high abort factor: drain path
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
			// keep writing until the collector kills the stream
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
			1024,
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
