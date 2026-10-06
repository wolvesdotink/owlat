// @vitest-environment happy-dom
/**
 * The record of a draft's expected attachments (#1257): kept in session state
 * and in sessionStorage, written by one mount at a time, settled into a small
 * marker once nothing is owed, and bounded in what it stores.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import {
	EXPECTED_RECORD_MAX_CHARS,
	EXPECTED_RECORD_TTL_MS,
	expectedRecordOpen,
	usePostboxExpectedAttachments,
	type ExpectedSource,
} from '../usePostboxExpectedAttachments';

let states: Record<string, unknown>;
beforeEach(() => {
	states = {};
	window.sessionStorage.clear();
	vi.useRealTimers();
	vi.stubGlobal('useState', (key: string, init: () => unknown) => (states[key] ??= ref(init())));
});

const RSVP: ExpectedSource = {
	kind: 'generated',
	attachment: { filename: 'reply.ics', contentType: 'text/calendar', content: 'BEGIN:VCALENDAR' },
};
const stored = (draftId: string) =>
	window.sessionStorage.getItem(`owlat:compose-expected:${draftId}`);

describe('usePostboxExpectedAttachments', () => {
	it('records what a draft was opened to carry, once, and keeps it across a reload', () => {
		const store = usePostboxExpectedAttachments();
		store.begin('d1', [RSVP]);
		store.begin('d1', [{ kind: 'forward', messageId: 'm1' as never }]);
		expect(store.read('d1')!.entries).toEqual([{ source: RSVP, files: null }]);

		states = {};
		expect(usePostboxExpectedAttachments().read('d1')!.entries).toEqual([
			{ source: RSVP, files: null },
		]);
	});

	it('takes writes only from the mount that claimed the record last', () => {
		const store = usePostboxExpectedAttachments();
		store.begin('d1', [RSVP]);
		store.claim('d1', 'first');
		store.claim('d1', 'second');
		const files = [
			{ filename: 'reply.ics', contentType: 'text/calendar', size: 15, state: 'pending' as const },
		];
		expect(store.update('d1', 'first', (r) => ({ ...r, entries: [{ source: RSVP, files }] }))).toBe(
			false
		);
		expect(store.read('d1')!.entries[0]!.files).toBeNull();
		expect(
			store.update('d1', 'second', (r) => ({ ...r, entries: [{ source: RSVP, files }] }))
		).toBe(true);
		expect(store.read('d1')!.entries[0]!.files).toEqual(files);
	});

	it('settles into a marker without the content once nothing is owed', () => {
		const store = usePostboxExpectedAttachments();
		store.begin('d1', [RSVP]);
		store.claim('d1', 'm');
		const done = [
			{ filename: 'reply.ics', contentType: 'text/calendar', size: 15, state: 'done' as const },
		];
		store.update('d1', 'm', (r) => ({ ...r, entries: [{ source: RSVP, files: done }] }));
		const record = store.read('d1')!;
		expect(record).toMatchObject({ settled: true, entries: [] });
		expect(expectedRecordOpen(record)).toBe(false);
		expect(stored('d1')).not.toContain('VCALENDAR');
		// A remount carrying the open's instructions finds the marker, not a fresh record.
		store.begin('d1', [RSVP]);
		expect(store.read('d1')!.settled).toBe(true);
	});

	it('keeps an oversized record in session state only', () => {
		const store = usePostboxExpectedAttachments();
		const huge: ExpectedSource = {
			kind: 'generated',
			attachment: {
				filename: 'big.ics',
				contentType: 'text/calendar',
				content: 'x'.repeat(EXPECTED_RECORD_MAX_CHARS),
			},
		};
		store.begin('d1', [huge]);
		expect(stored('d1')).toBeNull();
		expect(store.read('d1')!.entries[0]!.source).toEqual(huge);
	});

	it('forgets records past their lifetime', () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const store = usePostboxExpectedAttachments();
		store.begin('old', [RSVP]);
		vi.setSystemTime(1_000_000 + EXPECTED_RECORD_TTL_MS + 1);
		expect(store.read('old')).toBeNull();
		// The next record written prunes it from storage.
		store.begin('new', [RSVP]);
		expect(stored('old')).toBeNull();
		expect(stored('new')).not.toBeNull();
	});
});
