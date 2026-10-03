import { describe, expect, it } from 'vitest';
import {
	IMAP_WIRE_LEGACY,
	IMAP_WIRE_MIN_SUPPORTED,
	IMAP_WIRE_VERSION,
	imapWireVerdict,
} from '../imapWire';

describe('imapWireVerdict', () => {
	it('places a server against the backend contract window', () => {
		// Backend speaks 3 and still serves 2.
		expect(imapWireVerdict(3, 3, 2)).toBe('current');
		expect(imapWireVerdict(2, 3, 2)).toBe('supported');
		expect(imapWireVerdict(1, 3, 2)).toBe('unsupported');
		expect(imapWireVerdict(4, 3, 2)).toBe('ahead');
	});

	it('serves the release one behind and refuses the servers from before reporting', () => {
		// v0.6.8 speaks 1; v0.6.7 and older never report and count as legacy.
		expect(IMAP_WIRE_MIN_SUPPORTED).toBe(1);
		expect(imapWireVerdict(1)).toBe('supported');
		expect(imapWireVerdict(IMAP_WIRE_LEGACY)).toBe('unsupported');
		expect(imapWireVerdict(IMAP_WIRE_VERSION)).toBe('current');
	});
});
