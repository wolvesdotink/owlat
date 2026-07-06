/**
 * Inbox landing-mode resolution (utils/postboxInboxMode): 'today' is the
 * default for unset/unknown values; 'browse' is the only other valid mode.
 */
import { describe, it, expect } from 'vitest';
import { resolvePostboxInboxMode, POSTBOX_INBOX_MODE_DEFAULT } from '../postboxInboxMode';

describe('resolvePostboxInboxMode', () => {
	it('defaults to today', () => {
		expect(POSTBOX_INBOX_MODE_DEFAULT).toBe('today');
		expect(resolvePostboxInboxMode(undefined)).toBe('today');
		expect(resolvePostboxInboxMode(null)).toBe('today');
		expect(resolvePostboxInboxMode('')).toBe('today');
	});

	it('accepts the two valid modes', () => {
		expect(resolvePostboxInboxMode('today')).toBe('today');
		expect(resolvePostboxInboxMode('browse')).toBe('browse');
	});

	it('normalises unknown stored values to the default', () => {
		expect(resolvePostboxInboxMode('zen')).toBe('today');
		expect(resolvePostboxInboxMode('BROWSE')).toBe('today');
	});
});
