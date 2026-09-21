/**
 * Snooze scope: the whole conversation is the default (deferring one message
 * and leaving its siblings in the inbox is the failure mode this fixes), and
 * "just this message" stays available as the secondary choice.
 */
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_SNOOZE_SCOPE_DEFAULT,
	POSTBOX_SNOOZE_SCOPE_OPTIONS,
	resolvePostboxSnoozeScope,
} from '../postboxSnoozeScope';

describe('resolvePostboxSnoozeScope', () => {
	it('defaults to the whole conversation', () => {
		expect(resolvePostboxSnoozeScope(undefined)).toBe('thread');
		expect(resolvePostboxSnoozeScope(null)).toBe('thread');
		expect(POSTBOX_SNOOZE_SCOPE_DEFAULT).toBe('thread');
	});

	it('passes through both scopes and normalises anything else', () => {
		expect(resolvePostboxSnoozeScope('thread')).toBe('thread');
		expect(resolvePostboxSnoozeScope('message')).toBe('message');
		expect(resolvePostboxSnoozeScope('mailbox')).toBe('thread');
	});
});

describe('POSTBOX_SNOOZE_SCOPE_OPTIONS', () => {
	it('lists the thread scope first, each label a catalog key', () => {
		expect(POSTBOX_SNOOZE_SCOPE_OPTIONS.map((o) => o.value)).toEqual(['thread', 'message']);
		for (const option of POSTBOX_SNOOZE_SCOPE_OPTIONS) {
			expect(option.label).toMatch(/^shared\.postboxSnoozeScope\./);
		}
	});
});
