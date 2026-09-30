/**
 * Undo-send window semantics (plan idea 8): a stored value normalises to one of
 * the four offered windows, the DEFAULT window puts nothing on the wire (so an
 * untouched preference reproduces the exact `drafts.send` args the composer sent
 * before this control existed), and 'Off' is a real choice that survives the
 * round-trip — a zero-length hold with no undo toast, not a missing preference.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_UNDO_SEND_SECONDS, UNDO_SEND_SECOND_CHOICES } from '@owlat/shared/undoSendPolicy';
import { OFFLINE_QUEUE_UNDO_WINDOW_MS } from '~/composables/postbox/usePostboxOfflineOutbox';
import {
	POSTBOX_UNDO_SEND_SECONDS,
	POSTBOX_UNDO_SEND_DEFAULT_SECONDS,
	postboxUndoSendDelayMsArg,
	postboxUndoSendShowsToast,
	resolvePostboxUndoSendSeconds,
} from '../postboxUndoSendWindow';

describe('POSTBOX_UNDO_SEND_SECONDS', () => {
	it('offers exactly Off / 10 / 30 / 60', () => {
		expect([...POSTBOX_UNDO_SEND_SECONDS]).toEqual([0, 10, 30, 60]);
	});

	it('defaults to the 10s window the server applies (plan Q1)', () => {
		expect(POSTBOX_UNDO_SEND_DEFAULT_SECONDS).toBe(10);
		expect(POSTBOX_UNDO_SEND_SECONDS).toContain(POSTBOX_UNDO_SEND_DEFAULT_SECONDS);
	});
});

/**
 * The web half of the undo-send policy contract. The backend half — the stored
 * preference validator and the scheduling default are the same shared values —
 * lives in `apps/api/convex/mail/__tests__/undoSendPolicy.test.ts`; the web app
 * cannot import Convex modules, so the join is stated from both sides.
 */
describe('undo-send policy contract (web)', () => {
	it('offers the shared choices themselves, not a copy of them', () => {
		expect(POSTBOX_UNDO_SEND_SECONDS).toBe(UNDO_SEND_SECOND_CHOICES);
	});

	it('treats the shared default as the window that sends nothing', () => {
		expect(POSTBOX_UNDO_SEND_DEFAULT_SECONDS).toBe(DEFAULT_UNDO_SEND_SECONDS);
		expect(postboxUndoSendDelayMsArg(DEFAULT_UNDO_SEND_SECONDS)).toBeUndefined();
	});

	it('counts a queued offline send down for the shared default window', () => {
		expect(OFFLINE_QUEUE_UNDO_WINDOW_MS).toBe(DEFAULT_UNDO_SEND_SECONDS * 1_000);
	});
});

describe('resolvePostboxUndoSendSeconds', () => {
	it('reads an unset preference as the 10s default', () => {
		expect(resolvePostboxUndoSendSeconds(undefined)).toBe(10);
		expect(resolvePostboxUndoSendSeconds(null)).toBe(10);
	});

	it('passes every offered window through unchanged', () => {
		for (const seconds of POSTBOX_UNDO_SEND_SECONDS) {
			expect(resolvePostboxUndoSendSeconds(seconds)).toBe(seconds);
		}
	});

	it('keeps Off distinct from unset', () => {
		expect(resolvePostboxUndoSendSeconds(0)).toBe(0);
	});

	it('normalises a value outside the closed set back to the default', () => {
		expect(resolvePostboxUndoSendSeconds(45)).toBe(10);
		expect(resolvePostboxUndoSendSeconds(-10)).toBe(10);
		expect(resolvePostboxUndoSendSeconds(3600)).toBe(10);
	});
});

describe('postboxUndoSendDelayMsArg', () => {
	it('sends nothing on the default window, so the server keeps owning it', () => {
		expect(postboxUndoSendDelayMsArg(POSTBOX_UNDO_SEND_DEFAULT_SECONDS)).toBeUndefined();
	});

	it('sends an explicit zero for Off rather than omitting it', () => {
		expect(postboxUndoSendDelayMsArg(0)).toBe(0);
	});

	it('converts the other windows to milliseconds', () => {
		expect(postboxUndoSendDelayMsArg(60)).toBe(60_000);
	});

	it('sends the old 30s default explicitly, so a stored 30s choice survives the new default', () => {
		expect(postboxUndoSendDelayMsArg(30)).toBe(30_000);
	});
});

describe('postboxUndoSendShowsToast', () => {
	it('offers no undo for the Off window — there is nothing to cancel', () => {
		expect(postboxUndoSendShowsToast(0)).toBe(false);
	});

	it('offers undo for every window that actually holds the message', () => {
		expect(postboxUndoSendShowsToast(10)).toBe(true);
		expect(postboxUndoSendShowsToast(30)).toBe(true);
		expect(postboxUndoSendShowsToast(60)).toBe(true);
	});
});
