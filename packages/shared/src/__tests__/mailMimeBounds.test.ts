import { describe, it, expect } from 'vitest';
import { parseMessage, MAX_MIME_PARTS } from '@owlat/mail-message';
import { extractAttachments, extractAttachmentAt, extractFirstPartByType } from '../mailMime';

/**
 * `mailMime` is a thin adapter over the bounded `@owlat/mail-message` walker
 * (GHSA-72gq-2gg3-2vqq). These tests pin the bounds on the adapter itself and
 * pin that its attachment order is the one the writers (mail-sync ingest, the
 * MTA inbound route) record `partIndex` against, past the part budget too.
 */

/** Generous wall-clock ceiling: the bounded walker needs a fraction of it. */
const TIME_BUDGET_MS = 5_000;

function timed<T>(run: () => T): { value: T; ms: number } {
	const started = performance.now();
	const value = run();
	return { value, ms: performance.now() - started };
}

/** A message nested `depth` multipart levels deep with one attachment at the bottom. */
function deeplyNested(depth: number): string {
	const open: string[] = [];
	const close: string[] = [];
	for (let i = 0; i < depth; i++) {
		open.push(`Content-Type: multipart/mixed; boundary="b${i}"`, '', `--b${i}`);
		close.unshift(`--b${i}--`);
	}
	return [
		...open,
		'Content-Type: text/plain; name="deep.txt"',
		'Content-Disposition: attachment; filename="deep.txt"',
		'',
		'deep',
		...close,
	].join('\r\n');
}

/** A flat multipart/mixed message with `count` named attachment parts. */
function wide(count: number, withBody = true): string {
	const lines = ['Content-Type: multipart/mixed; boundary="W"', ''];
	for (let i = 0; i < count; i++) {
		lines.push('--W', `Content-Disposition: attachment; filename="f${i}.txt"`, '');
		if (withBody) lines.push(`part ${i}`);
	}
	lines.push('--W--', '');
	return lines.join('\r\n');
}

describe('mailMime bounds', () => {
	it('walks a message nested 10,000 levels deep in bounded time without throwing', () => {
		const raw = deeplyNested(10_000);
		const { value, ms } = timed(() => ({
			all: extractAttachments(raw),
			calendar: extractFirstPartByType(raw, 'text/calendar'),
			at: extractAttachmentAt(raw, '0', 'deep.txt'),
		}));
		expect(ms).toBeLessThan(TIME_BUDGET_MS);
		// Past the depth ceiling the remaining subtree is an opaque leaf.
		expect(value.all).toEqual([]);
		expect(value.calendar).toBeNull();
		expect(value.at).toBeNull();
	});

	it('walks a message with 100,000 parts in bounded time without throwing', () => {
		const raw = wide(100_000, false);
		const { value, ms } = timed(() => extractAttachments(raw));
		expect(ms).toBeLessThan(TIME_BUDGET_MS);
		expect(value.length).toBeLessThanOrEqual(MAX_MIME_PARTS);
		expect(extractAttachmentAt(raw, String(MAX_MIME_PARTS + 10))).toBeNull();
	});

	it('splits a part holding a very long blank-padded line in bounded time', () => {
		// One ~1 MB line of spaces ending in a non-blank byte, nested 100 levels
		// deep, so every level rescans the line when looking for its delimiter.
		const longLine = `${' '.repeat(1_000_000)}x`;
		const open: string[] = [];
		const close: string[] = [];
		for (let i = 0; i < 100; i++) {
			open.push(`Content-Type: multipart/mixed; boundary="p${i}"`, '', `--p${i}`);
			close.unshift(`--p${i}--`);
		}
		const raw = [
			...open,
			'Content-Type: text/plain',
			'Content-Disposition: attachment; filename="pad.txt"',
			'',
			longLine,
			...close,
		].join('\r\n');
		const { value, ms } = timed(() => extractAttachments(raw));
		expect(ms).toBeLessThan(TIME_BUDGET_MS);
		expect(value.map((a) => [a.filename, a.bytes.length])).toEqual([['pad.txt', longLine.length]]);
	});

	it('splits a flat part holding a very long blank-padded line in bounded time', () => {
		const raw = [
			'Content-Type: multipart/mixed; boundary="L"',
			'',
			'--L',
			'Content-Disposition: attachment; filename="pad.txt"',
			'',
			`${' \t'.repeat(500_000)}x`,
			'--L  ',
			'Content-Disposition: attachment; filename="after.txt"',
			'',
			'after',
			'--L--\t',
			'',
		].join('\r\n');
		const { value, ms } = timed(() => extractAttachments(raw));
		expect(ms).toBeLessThan(TIME_BUDGET_MS);
		expect(value.map((a) => a.filename)).toEqual(['pad.txt', 'after.txt']);
	});

	it('returns the same attachment order as the writers past 1,000 parts', () => {
		const raw = wide(1_500);
		const ours = extractAttachments(raw);
		// The writers (mail-sync ingest, MTA bounce outcome) record
		// `partIndex = String(i)` over `parseMessage(bytes).attachments`.
		const theirs = parseMessage(Buffer.from(raw, 'latin1')).attachments;
		// Pinned independently of either side: the first MAX_MIME_PARTS parts,
		// in wire order.
		const expected = Array.from({ length: MAX_MIME_PARTS }, (_, i) => `f${i}.txt`);
		expect(ours.map((a) => a.filename)).toEqual(expected);
		expect(theirs.map((a) => a.filename)).toEqual(expected);
		expect(ours.map((a) => [...a.bytes])).toEqual(theirs.map((a) => [...a.content]));
		// Every index the writers can record resolves to the same part.
		for (const i of [0, 1, 499, MAX_MIME_PARTS - 1]) {
			const at = extractAttachmentAt(raw, String(i));
			expect(at?.filename).toBe(theirs[i]!.filename);
			expect(new TextDecoder().decode(at!.bytes)).toBe(`part ${i}`);
		}
	});
});
