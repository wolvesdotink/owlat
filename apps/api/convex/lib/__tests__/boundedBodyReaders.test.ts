/**
 * The bounded body readers: `readStreamPrefix` (the primitive, in
 * `@owlat/shared` next to `readStreamBytes`, which HTTP actions read request
 * bodies with) and, in ssrfGuard, `readCappedBytes` (reject past the cap) and
 * `readBodyPreview` (keep the head).
 *
 * Every stream here is pull-based with a zero high-water mark, so the meter
 * counts exactly the bytes the reader asked the producer for. That is the
 * property under test: a huge or never-ending body must cost at most the cap
 * plus one chunk, and the producer must be cancelled rather than drained.
 */

import { describe, expect, it } from 'vitest';
import { readStreamBytes, readStreamPrefix, StreamByteLimitExceeded } from '@owlat/shared';
import { CappedReadOverflow, readBodyPreview, readCappedBytes } from '../ssrfGuard';
import { meteredStream } from './meteredStream';

const encode = (text: string) => new TextEncoder().encode(text);
const fromChunks = (chunks: Uint8Array[]) => meteredStream((i) => chunks[i]);
const endless = (chunkBytes: number) => meteredStream(() => new Uint8Array(chunkBytes).fill(0x61));

describe('readStreamPrefix', () => {
	it('reassembles a chunked body that fits', async () => {
		const { stream, meter } = fromChunks(['alpha ', 'beta ', 'gamma'].map(encode));
		const prefix = await readStreamPrefix(stream, 1024);
		expect(new TextDecoder().decode(prefix!.bytes)).toBe('alpha beta gamma');
		expect(prefix!.truncated).toBe(false);
		expect(meter.cancelled).toBe(false);
	});

	it('stops a never-ending body at the cap and cancels the producer', async () => {
		const { stream, meter } = endless(1024);
		const prefix = await readStreamPrefix(stream, 4096);
		expect(prefix!.bytes.byteLength).toBe(4096);
		expect(prefix!.truncated).toBe(true);
		expect(meter.pulledBytes).toBeLessThanOrEqual(4096 + 1024);
		expect(meter.cancelled).toBe(true);
	});

	it('keeps the head of a single chunk that overshoots the cap', async () => {
		const { stream, meter } = fromChunks([encode('0123456789')]);
		const prefix = await readStreamPrefix(stream, 4);
		expect(new TextDecoder().decode(prefix!.bytes)).toBe('0123');
		expect(prefix!.truncated).toBe(true);
		expect(meter.cancelled).toBe(true);
	});

	it('gives up on a stalled producer after the time budget and cancels it', async () => {
		const { stream, meter } = meteredStream((i) => (i === 0 ? encode('partial') : 'stall'));
		const prefix = await readStreamPrefix(stream, 4096, { timeoutMs: 20 });
		expect(new TextDecoder().decode(prefix!.bytes)).toBe('partial');
		expect(prefix!.truncated).toBe(true);
		expect(meter.cancelled).toBe(true);
	});

	it('propagates a stream error', async () => {
		const { stream } = meteredStream((i) => (i === 0 ? encode('x') : new Error('reset')));
		await expect(readStreamPrefix(stream, 64)).rejects.toThrow('reset');
	});

	it('returns null for a missing body and rejects a bad cap', async () => {
		expect(await readStreamPrefix(null, 10)).toBeNull();
		await expect(readStreamPrefix(fromChunks([]).stream, -1)).rejects.toThrow(RangeError);
	});
});

describe('readCappedBytes', () => {
	it('returns a body of exactly the cap', async () => {
		const bytes = await readCappedBytes(fromChunks([encode('abcd')]).stream, 4);
		expect(new TextDecoder().decode(bytes!)).toBe('abcd');
	});

	it('throws CappedReadOverflow past the cap without draining the producer', async () => {
		const { stream, meter } = endless(512);
		await expect(readCappedBytes(stream, 2048)).rejects.toBeInstanceOf(CappedReadOverflow);
		expect(meter.pulledBytes).toBeLessThanOrEqual(2048 + 512);
		expect(meter.cancelled).toBe(true);
	});
});

describe('readStreamBytes', () => {
	it('returns a body of exactly the cap', async () => {
		const bytes = await readStreamBytes(fromChunks([encode('ab'), encode('cd')]).stream, 4);
		expect(new TextDecoder().decode(bytes!)).toBe('abcd');
	});

	it('throws StreamByteLimitExceeded past the cap without draining the producer', async () => {
		const { stream, meter } = endless(512);
		await expect(readStreamBytes(stream, 2048)).rejects.toBeInstanceOf(StreamByteLimitExceeded);
		expect(meter.pulledBytes).toBeLessThanOrEqual(2048 + 512);
		expect(meter.cancelled).toBe(true);
	});
});

describe('readBodyPreview', () => {
	const opts = { maxBytes: 64, timeoutMs: 1_000 };

	it('decodes a multibyte character split across chunks', async () => {
		const bytes = encode('prix: 5 €, ok');
		const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte euro sign
		const { stream } = fromChunks([bytes.subarray(0, cut), bytes.subarray(cut)]);
		expect(await readBodyPreview(stream, opts)).toEqual({
			text: 'prix: 5 €, ok',
			truncated: false,
		});
	});

	it('drops a multibyte character the byte cap cuts through instead of emitting U+FFFD', async () => {
		// "ab" + two euro signs: the 4-byte cap lands after the first byte pair of €.
		const { stream } = fromChunks([encode('ab€€')]);
		const preview = await readBodyPreview(stream, { maxBytes: 4, timeoutMs: 1_000 });
		expect(preview).toEqual({ text: 'ab', truncated: true });
		expect(preview.text).not.toContain('\uFFFD');
	});

	it('bounds an oversized body', async () => {
		const { stream, meter } = endless(4096);
		const preview = await readBodyPreview(stream, opts);
		expect(preview.text).toBe('a'.repeat(64));
		expect(preview.truncated).toBe(true);
		expect(meter.pulledBytes).toBeLessThanOrEqual(4096);
		expect(meter.cancelled).toBe(true);
	});

	it('never throws: a body that errors mid-read yields an empty, truncated preview', async () => {
		const { stream } = meteredStream((i) =>
			i === 0 ? encode('half') : new Error('socket hang up')
		);
		expect(await readBodyPreview(stream, opts)).toEqual({ text: '', truncated: true });
	});

	it('treats a missing body as an empty, complete preview', async () => {
		expect(await readBodyPreview(null, opts)).toEqual({ text: '', truncated: false });
	});
});
