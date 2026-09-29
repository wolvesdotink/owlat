import { describe, it, expect } from 'vitest';
import { extractAttachments as messageExtract, MAX_MIME_PARTS } from '@owlat/mail-message';
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

	it('returns the same attachment order as mail-message past 1,000 parts', () => {
		const raw = wide(1_500);
		const ours = extractAttachments(raw);
		const theirs = messageExtract(raw);
		expect(ours.map((a) => a.filename)).toEqual(theirs.map((a) => a.filename));
		expect(ours.map((a) => [...a.bytes])).toEqual(theirs.map((a) => [...a.content]));
		// Every index the writers can record resolves to the same part.
		const last = theirs.length - 1;
		expect(extractAttachmentAt(raw, String(last))?.filename).toBe(theirs[last]!.filename);
	});
});
