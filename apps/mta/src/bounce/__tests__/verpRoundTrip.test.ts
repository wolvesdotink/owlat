/**
 * Async-DSN attribution round-trip (audit PR-01).
 *
 * The MTA encodes the send's stored `providerMessageId` into the VERP
 * Return-Path (apps/mta/src/smtp/sender.ts → buildVerpAddress(job.messageId)).
 * When a remote MTA later returns an asynchronous bounce DSN, the bounce lands
 * on that VERP envelope recipient; `parseBounce` must decode the SAME token back
 * out so Convex can look the send up by_provider_message_id and suppress the
 * address. RFC 5321 §4.4 (Return-Path / trace).
 *
 * This locks the encode→decode round-trip with the REAL verp + classifier
 * (only the logger is stubbed): if the two ever drift, a real bounce becomes
 * "unattributed" and is silently dropped, inflating bounce rates past the
 * Gmail/Yahoo suppression thresholds.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { ParsedMessage } from '@owlat/mail-message';
import { parseBounce } from '../parser.js';
import { buildVerpAddress } from '../verp.js';

const VERP_KEY = 'round-trip-test-verp-key-012345678901';
afterEach(() => delete process.env['BOUNCE_VERP_KEY']);

function createMockParsedMail(overrides: Record<string, unknown> = {}): ParsedMessage {
	return {
		text: '',
		subject: '',
		headers: new Map(),
		attachments: [],
		...overrides,
	} as unknown as ParsedMessage;
}

describe('VERP round-trip — bounce attribution (PR-01)', () => {
	it('decodes the stored providerMessageId back out of a DSN addressed to its VERP envelope', () => {
		process.env['BOUNCE_VERP_KEY'] = VERP_KEY;
		// Exactly what the worker stores on the Send row after the /send fix:
		// providerMessageId === messageId === `send_<emailSendId>`.
		const storedProviderMessageId = 'send_jh7abcdef0123456789';

		// The MTA stamps this onto the Return-Path for every outbound message.
		const verp = buildVerpAddress(storedProviderMessageId, 'bounces.test', VERP_KEY);
		expect(verp.startsWith('bounce+')).toBe(true);
		expect(verp.endsWith('@bounces.test')).toBe(true);

		// A minimal RFC 3464 delivery-status report bouncing to that VERP address.
		const dsn = createMockParsedMail({
			subject: 'Delivery Status Notification (Failure)',
			from: { text: 'MAILER-DAEMON@mx.remote.test' },
			text: [
				'Reporting-MTA: dns; mx.remote.test',
				'',
				'Final-Recipient: rfc822; user@remote.test',
				'Action: failed',
				'Status: 5.1.1',
				'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
			].join('\n'),
		});

		// The DSN attributes via its VERP envelope token, not a report part.
		const result = parseBounce(dsn, [], verp);

		expect(result).not.toBeNull();
		// The decoded token equals the stored providerMessageId — this is the key
		// Convex uses for the by_provider_message_id lookup.
		expect(result!.originalMessageId).toBe(storedProviderMessageId);
		// 5.1.1 is a permanent address failure → hard bounce → blocklist insert.
		expect(result!.bounceType).toBe('hard');
	});
});
