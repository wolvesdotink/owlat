/**
 * Unit tests for the version-history rules (`emailTemplates/versionSnapshot.ts`).
 *
 * These are the three decisions that make persisted history trustworthy:
 * a fingerprint that cannot confuse two different templates, a dedupe rule that
 * suppresses no-op saves but never a distinct event, and a retention split that
 * always evicts the OLDEST rows.
 */

import { describe, it, expect } from 'vitest';
import {
	VERSION_HISTORY_LIMIT,
	fingerprintSnapshot,
	selectVersionsToEvict,
	shouldCaptureVersion,
	snapshotByteLength,
} from '../versionSnapshot';

const source = (over: Partial<{ name: string; subject: string; content: string }> = {}) => ({
	name: 'Welcome',
	subject: 'Hello there',
	content: '[{"id":"a","type":"text"}]',
	...over,
});

describe('fingerprintSnapshot', () => {
	it('is stable for identical input and different for any changed field', () => {
		const base = fingerprintSnapshot(source()).contentHash;

		expect(fingerprintSnapshot(source()).contentHash).toBe(base);
		expect(fingerprintSnapshot(source({ name: 'Welcome ' })).contentHash).not.toBe(base);
		expect(fingerprintSnapshot(source({ subject: 'Hello there!' })).contentHash).not.toBe(base);
		expect(fingerprintSnapshot(source({ content: '[]' })).contentHash).not.toBe(base);
	});

	it('does not confuse a field-boundary shift (name/subject are NUL-separated)', () => {
		const a = fingerprintSnapshot(source({ name: 'ab', subject: 'c', content: '[]' }));
		const b = fingerprintSnapshot(source({ name: 'a', subject: 'bc', content: '[]' }));
		expect(a.contentHash).not.toBe(b.contentHash);
	});

	it('reports the UTF-8 byte length of the content, not its code-unit length', () => {
		const emoji = '["\u{1F680}"]'; // 4-byte rocket inside a 4-char JSON wrapper
		expect(fingerprintSnapshot(source({ content: emoji })).contentBytes).toBe(
			snapshotByteLength(emoji)
		);
		expect(snapshotByteLength(emoji)).toBeGreaterThan(emoji.length);
	});
});

describe('shouldCaptureVersion', () => {
	it('always captures the first version', () => {
		expect(shouldCaptureVersion(null, { contentHash: 'h1', trigger: 'save' })).toBe(true);
	});

	it('skips a repeat save of unchanged content', () => {
		expect(
			shouldCaptureVersion(
				{ contentHash: 'h1', trigger: 'save' },
				{ contentHash: 'h1', trigger: 'save' }
			)
		).toBe(false);
	});

	it('captures changed content under the same trigger', () => {
		expect(
			shouldCaptureVersion(
				{ contentHash: 'h1', trigger: 'save' },
				{ contentHash: 'h2', trigger: 'save' }
			)
		).toBe(true);
	});

	it('captures unchanged content under a different trigger — publish and send are events', () => {
		expect(
			shouldCaptureVersion(
				{ contentHash: 'h1', trigger: 'save' },
				{ contentHash: 'h1', trigger: 'publish' }
			)
		).toBe(true);
		expect(
			shouldCaptureVersion(
				{ contentHash: 'h1', trigger: 'publish' },
				{ contentHash: 'h1', trigger: 'send' }
			)
		).toBe(true);
	});
});

describe('selectVersionsToEvict', () => {
	it('evicts nothing while at or under the cap', () => {
		const rows = Array.from({ length: VERSION_HISTORY_LIMIT }, (_, i) => i);
		expect(selectVersionsToEvict(rows)).toEqual([]);
	});

	it('evicts the tail of a newest-first list — the oldest rows', () => {
		// Newest first: 0 is the newest, 54 the oldest.
		const rows = Array.from({ length: VERSION_HISTORY_LIMIT + 5 }, (_, i) => i);
		const evicted = selectVersionsToEvict(rows);
		expect(evicted).toEqual([50, 51, 52, 53, 54]);
		expect(evicted).toHaveLength(5);
	});

	it('honours an explicit lower limit', () => {
		expect(selectVersionsToEvict(['a', 'b', 'c'], 1)).toEqual(['b', 'c']);
	});
});
