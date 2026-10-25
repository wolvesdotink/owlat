import { describe, it, expect, vi } from 'vitest';
import { parseMessage, MAX_MIME_PARTS } from '@owlat/mail-message';
import {
	extractAttachments,
	extractAttachmentsWithBounds,
	extractAttachmentAt,
	extractFirstPartByType,
} from '../mailMime';
import type * as BodyModule from '@owlat/mail-message/parse/body';
import type * as LocateModule from '@owlat/mail-message/parse/locate';

/**
 * `mailMime` is a thin adapter over the bounded `@owlat/mail-message` walker
 * (GHSA-72gq-2gg3-2vqq). These tests pin the bounds on the adapter itself and
 * pin that its attachment order is the one the writers (mail-sync ingest, the
 * MTA inbound route) record `partIndex` against, past the part budget too.
 */

/**
 * The bytes the bounded walkers' line scans read, and how many walks the
 * adapter started, read through the walkers' test meters (mocked in below).
 * A linear walk reads each byte once.
 */
const walks = vi.hoisted(() => ({ count: 0, meter: { bytes: 0 } }));

vi.mock('@owlat/mail-message/parse/body', async (importOriginal) => {
	const actual = await importOriginal<typeof BodyModule>();
	const withBounds = (raw: string, depth?: number, nested?: boolean) => {
		walks.count += 1;
		return actual.parseMimeTreeWithBounds(raw, depth, nested, walks.meter);
	};
	return {
		...actual,
		parseMimeTreeWithBounds: withBounds,
		parseMimeTree: (raw: string, depth?: number, nested?: boolean) =>
			withBounds(raw, depth, nested).root,
	};
});

vi.mock('@owlat/mail-message/parse/locate', async (importOriginal) => {
	const actual = await importOriginal<typeof LocateModule>();
	return {
		...actual,
		locateMimeTree: (raw: Uint8Array) => {
			walks.count += 1;
			return actual.locateMimeTree(raw, walks.meter);
		},
	};
});

/**
 * Run `call` and check it parsed `raw` exactly once and read each of its bytes
 * at most once. Both bounds are fixed by the input alone: a byte budget scaled
 * by the observed walk count would let an adapter that reparses the message per
 * megabyte go quadratic unnoticed.
 */
function linear<T>(raw: string, call: () => T): T {
	walks.count = 0;
	walks.meter.bytes = 0;
	const value = call();
	expect(walks.count).toBe(1);
	expect(walks.meter.bytes).toBeLessThanOrEqual(raw.length + 1);
	return value;
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
	it('walks a message nested 10,000 levels deep in one pass without throwing', () => {
		const raw = deeplyNested(10_000);
		const value = {
			all: linear(raw, () => extractAttachments(raw)),
			calendar: linear(raw, () => extractFirstPartByType(raw, 'text/calendar')),
			at: linear(raw, () => extractAttachmentAt(raw, '0', 'deep.txt')),
		};
		// Past the depth ceiling the remaining subtree is an opaque leaf.
		expect(value.all).toEqual([]);
		expect(value.calendar).toBeNull();
		expect(value.at).toBeNull();
	});

	it('walks a message with 100,000 parts in one pass without throwing', () => {
		const raw = wide(100_000, false);
		const value = linear(raw, () => extractAttachments(raw));
		expect(value.length).toBeLessThanOrEqual(MAX_MIME_PARTS);
		expect(linear(raw, () => extractAttachmentAt(raw, String(MAX_MIME_PARTS + 10)))).toBeNull();
	});

	it('splits a part holding a very long blank-padded line in one pass', () => {
		// A large part nested 100 levels deep; the split reads it once, however
		// many levels it sits under.
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
		const value = linear(raw, () => extractAttachments(raw));
		expect(value.map((a) => [a.filename, a.bytes.length])).toEqual([['pad.txt', longLine.length]]);
	});

	it('splits a flat part holding a very long blank-padded line in one pass', () => {
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
		const value = linear(raw, () => extractAttachments(raw));
		expect(value.map((a) => a.filename)).toEqual(['pad.txt', 'after.txt']);
	});

	it('reports when the bounds left attachment leaves out', () => {
		expect(extractAttachmentsWithBounds(wide(MAX_MIME_PARTS)).truncated).toBe(false);
		const past = extractAttachmentsWithBounds(wide(MAX_MIME_PARTS + 1));
		expect(past.truncated).toBe(true);
		expect(past.attachments).toHaveLength(MAX_MIME_PARTS);
		const deep = extractAttachmentsWithBounds(deeplyNested(101));
		expect(deep).toEqual({ attachments: [], truncated: true });
		expect(extractAttachmentsWithBounds(deeplyNested(100)).attachments).toHaveLength(1);
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
