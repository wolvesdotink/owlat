import { describe, expect, it } from 'vitest';
import {
	MemoryReportDedupeStore,
	reportDedupeKey,
	shouldCaptureReport,
	type ReportDedupeStore,
} from '../dedupe.js';

const message = { messageId: '<abc123@example.com>', bodyHash: '2jmj7l5rSw0yVb/vlWAYkK/YBwk=' };

describe('shouldCaptureReport (§7.3 replay)', () => {
	it('captures the first report and drops the replay', () => {
		const seen = new MemoryReportDedupeStore();
		const first = shouldCaptureReport(message, seen, '2026-08-19T09:00:00Z');
		expect(first.capture).toBe(true);

		const second = shouldCaptureReport(message, seen, '2026-08-19T11:00:00Z');
		expect(second).toEqual({ capture: false, key: first.key, reason: 'duplicate' });
		expect(seen.size).toBe(1);
	});

	it('treats a different body hash under the same Message-ID as a new message', () => {
		const seen = new MemoryReportDedupeStore();
		shouldCaptureReport(message, seen, '2026-08-19T09:00:00Z');
		const other = shouldCaptureReport(
			{ ...message, bodyHash: 'frcCV1k9oG9oKj3dpUqdJg1PxRT2RSN/XKdLCPjaYaY=' },
			seen,
			'2026-08-19T09:00:01Z'
		);
		expect(other.capture).toBe(true);
		expect(seen.size).toBe(2);
	});

	it('preserves Message-ID case: the local part is case-sensitive', () => {
		const seen = new MemoryReportDedupeStore();
		shouldCaptureReport(message, seen, '2026-08-19T09:00:00Z');
		const upper = shouldCaptureReport(
			{ ...message, messageId: '<ABC123@example.com>' },
			seen,
			'2026-08-19T09:00:00Z'
		);
		expect(upper.capture).toBe(true);
	});

	it('refuses an incomplete identity without touching the store', () => {
		const seen = new MemoryReportDedupeStore();
		expect(
			shouldCaptureReport({ messageId: '', bodyHash: 'x' }, seen, '2026-08-19T09:00:00Z')
		).toEqual({ capture: false, key: null, reason: 'incomplete' });
		expect(
			shouldCaptureReport({ messageId: 'x', bodyHash: '  ' }, seen, '2026-08-19T09:00:00Z')
		).toEqual({ capture: false, key: null, reason: 'incomplete' });
		expect(seen.size).toBe(0);
	});

	it('stores an opaque digest, not the Message-ID', () => {
		const key = reportDedupeKey(message);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(key).not.toContain('abc123');
	});

	it('cannot be forged by moving bytes across the field boundary', () => {
		expect(reportDedupeKey({ messageId: 'a b', bodyHash: 'c' })).not.toBe(
			reportDedupeKey({ messageId: 'a', bodyHash: 'b c' })
		);
	});

	it('re-admits a report once the retention window has dropped it', () => {
		const seen = new MemoryReportDedupeStore();
		shouldCaptureReport(message, seen, '2026-05-01T00:00:00Z');
		expect(seen.prune('2026-08-01T00:00:00Z')).toBe(1);
		expect(shouldCaptureReport(message, seen, '2026-08-19T09:00:00Z').capture).toBe(true);
	});

	it('keeps entries inside the retention window and drops unparseable ones', () => {
		const seen = new MemoryReportDedupeStore();
		shouldCaptureReport(message, seen, '2026-08-18T00:00:00Z');
		shouldCaptureReport({ messageId: 'x', bodyHash: 'y' }, seen, 'whenever');
		expect(seen.prune('2026-08-01T00:00:00Z')).toBe(1);
		expect(seen.size).toBe(1);
		expect(shouldCaptureReport(message, seen, '2026-08-19T09:00:00Z').capture).toBe(false);
	});

	it('echoes the reporter token back, and keeps it out of the dedupe key', () => {
		const seen = new MemoryReportDedupeStore();
		const first = shouldCaptureReport(
			{ ...message, reporter: 'mbx-a' },
			seen,
			'2026-08-19T09:00:00Z'
		);
		expect(first).toEqual({ capture: true, key: reportDedupeKey(message), reporter: 'mbx-a' });

		// A second user reporting the same replayed message is still one message.
		const second = shouldCaptureReport(
			{ ...message, reporter: 'mbx-b' },
			seen,
			'2026-08-19T09:05:00Z'
		);
		expect(second.capture).toBe(false);
		expect(reportDedupeKey({ ...message, reporter: 'mbx-b' })).toBe(reportDedupeKey(message));
	});

	it('omits the token rather than echoing an empty one', () => {
		const seen = new MemoryReportDedupeStore();
		expect(shouldCaptureReport({ ...message, reporter: '' }, seen, '2026-08-19T09:00:00Z')).toEqual(
			{ capture: true, key: reportDedupeKey(message) }
		);
	});

	it('works against an app-supplied store', () => {
		const keys: string[] = [];
		const store: ReportDedupeStore = {
			has: (key) => keys.includes(key),
			add: (key) => {
				keys.push(key);
			},
		};
		expect(shouldCaptureReport(message, store, '2026-08-19T09:00:00Z').capture).toBe(true);
		expect(shouldCaptureReport(message, store, '2026-08-19T09:00:00Z').capture).toBe(false);
		expect(keys).toHaveLength(1);
	});
});
