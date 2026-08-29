/**
 * Undo-send window semantics (plan idea 8): a stored value normalises to one of
 * the four offered windows, the DEFAULT window puts nothing on the wire (so an
 * untouched preference reproduces the exact `drafts.send` args the composer sent
 * before this control existed), and 'Off' is a real choice that survives the
 * round-trip — a zero-length hold with no undo toast, not a missing preference.
 */
import { describe, it, expect } from 'vitest';
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

	it('defaults to the 30s window the server already applies', () => {
		expect(POSTBOX_UNDO_SEND_DEFAULT_SECONDS).toBe(30);
		expect(POSTBOX_UNDO_SEND_SECONDS).toContain(POSTBOX_UNDO_SEND_DEFAULT_SECONDS);
	});
});

describe('resolvePostboxUndoSendSeconds', () => {
	it('reads an unset preference as the 30s default', () => {
		expect(resolvePostboxUndoSendSeconds(undefined)).toBe(30);
		expect(resolvePostboxUndoSendSeconds(null)).toBe(30);
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
		expect(resolvePostboxUndoSendSeconds(45)).toBe(30);
		expect(resolvePostboxUndoSendSeconds(-10)).toBe(30);
		expect(resolvePostboxUndoSendSeconds(3600)).toBe(30);
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
		expect(postboxUndoSendDelayMsArg(10)).toBe(10_000);
		expect(postboxUndoSendDelayMsArg(60)).toBe(60_000);
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
