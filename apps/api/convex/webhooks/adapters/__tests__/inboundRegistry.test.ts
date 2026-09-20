/**
 * The inbound normalization contract: what each source turns a raw envelope
 * into, field by field, including the fallbacks that only fire on a malformed
 * payload and the auth verdicts that must stay *absent* rather than become a
 * pass.
 */

import { describe, expect, it } from 'vitest';
import { getInboundChannelAdapter } from '../inboundRegistry';

/** A well-formed `inbound.received` envelope from owlat-mta. */
function mtaEnvelope(overrides: Record<string, unknown> = {}, timestamp = 1_700_000_000_000) {
	return {
		inboundPayload: {
			from: 'sender@example.com',
			to: 'inbox@owlat.test',
			subject: 'Hello',
			textBody: 'plain',
			htmlBody: '<p>rich</p>',
			headers: { 'x-owlat': '1' },
			messageId: '<abc@example.com>',
			inReplyTo: '<parent@example.com>',
			references: '<root@example.com>',
			attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', size: 12 }],
			...overrides,
		},
		timestamp,
	};
}

// =============================================================================
// Bucket 1 — the MTA source: envelope → canonical mail
// =============================================================================
describe('MtaInboundAdapter', () => {
	it('normalizes a full envelope onto the canonical shape', () => {
		const mail = getInboundChannelAdapter('mta').parseInbound(mtaEnvelope());

		expect(mail).toEqual({
			from: 'sender@example.com',
			to: 'inbox@owlat.test',
			subject: 'Hello',
			textBody: 'plain',
			htmlBody: '<p>rich</p>',
			headers: { 'x-owlat': '1' },
			messageId: '<abc@example.com>',
			inReplyTo: '<parent@example.com>',
			references: '<root@example.com>',
			attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', size: 12 }],
			timestamp: 1_700_000_000_000,
			spfResult: undefined,
			dkimResult: undefined,
			dmarcResult: undefined,
			dmarcPolicy: undefined,
		});
	});

	it('carries the four inbound auth verdicts through untouched', () => {
		const mail = getInboundChannelAdapter('mta').parseInbound(
			mtaEnvelope({
				spfResult: 'pass',
				dkimResult: 'fail',
				dmarcResult: 'none',
				dmarcPolicy: 'quarantine',
			})
		);

		expect(mail.spfResult).toBe('pass');
		expect(mail.dkimResult).toBe('fail');
		expect(mail.dmarcResult).toBe('none');
		expect(mail.dmarcPolicy).toBe('quarantine');
	});

	it('leaves an omitted verdict undefined — never a pass', () => {
		// An older MTA (or one with a check disabled) sends no verdict at all.
		// Downstream renders `undefined` as "unknown"; inventing a value here
		// would render a forged sender as authenticated.
		const mail = getInboundChannelAdapter('mta').parseInbound(mtaEnvelope({ spfResult: 'pass' }));

		expect(mail.spfResult).toBe('pass');
		expect(mail.dkimResult).toBeUndefined();
		expect(mail.dmarcResult).toBeUndefined();
		expect(mail.dmarcPolicy).toBeUndefined();
	});

	it('carries the ARC triple, which is what rescues a forwarded DMARC fail', () => {
		const mail = getInboundChannelAdapter('mta').parseInbound(
			mtaEnvelope({
				dmarcResult: 'fail',
				arcCv: 'pass',
				arcSealerDomain: 'forwarder.example',
				arcAttestsOriginalPass: true,
			})
		);

		expect(mail.arcCv).toBe('pass');
		expect(mail.arcSealerDomain).toBe('forwarder.example');
		expect(mail.arcAttestsOriginalPass).toBe(true);
	});

	it('drops an unexpected key on an attachment rather than 500ing the route', () => {
		// `inboundEmailMessageValidator` spells each element as a CLOSED
		// `v.object`, and Convex refuses an unknown field in one — so a single
		// extra key threw inside the route's `ctx.runAction`, answered 500 and
		// burned the MTA's six retries into the DLQ with nothing stored.
		// `redisKey` is exactly what a pre-#659 MTA put on every element, and the
		// upgraded binary replays its DLQ backlog at this route.
		const mail = getInboundChannelAdapter('mta').parseInbound(
			mtaEnvelope({
				attachments: [
					{
						filename: 'a.txt',
						contentType: 'text/plain',
						size: 5,
						partIndex: '1',
						redisKey: 'mta:inbound-att:x:0',
					},
				],
			})
		);

		expect(mail.attachments).toEqual([
			{ filename: 'a.txt', contentType: 'text/plain', size: 5, partIndex: '1' },
		]);
	});

	it('defaults a wrong-typed attachment field instead of losing the mail', () => {
		const mail = getInboundChannelAdapter('mta').parseInbound(
			mtaEnvelope({
				attachments: [
					{ filename: 7, contentType: 'text/plain', size: '12', partIndex: 3 },
					{ contentType: 'application/pdf', size: 9, partIndex: '2' },
					'not an object',
					null,
				],
			})
		);

		// Metadata only — the BYTES are in the raw `.eml`. A wrong-typed name or
		// index simply goes absent (every reader already falls back), a
		// non-numeric size reads as 0, and a non-object element is not an
		// attachment at all.
		expect(mail.attachments).toEqual([
			{ contentType: 'text/plain', size: 0 },
			{ contentType: 'application/pdf', size: 9, partIndex: '2' },
		]);
	});

	it('answers a missing or non-array attachment list with no attachments', () => {
		expect(
			getInboundChannelAdapter('mta').parseInbound(mtaEnvelope({ attachments: undefined }))
				.attachments
		).toEqual([]);
		expect(
			getInboundChannelAdapter('mta').parseInbound(mtaEnvelope({ attachments: { a: 1 } }))
				.attachments
		).toEqual([]);
	});

	it('synthesizes a message id from the envelope timestamp when one is missing', () => {
		const mail = getInboundChannelAdapter('mta').parseInbound(
			mtaEnvelope({ messageId: undefined }, 42)
		);

		expect(mail.messageId).toBe('unknown-42');
		expect(mail.timestamp).toBe(42);
	});
});

// =============================================================================
// Bucket 2 — the Resend source: the mapping the deleted EmailAdapter applied
//
// Its `parseInbound` was the one honest method on a class whose other three
// were fictions. The class is deleted and this mapping is inlined, so these
// cases are the record of what "unchanged" means.
// =============================================================================
describe('ResendInboundAdapter', () => {
	const resend = getInboundChannelAdapter('resend');

	it('maps a flat payload field for field', () => {
		const mail = resend.parseInbound({
			from: 'a@example.com',
			to: 'b@example.com',
			subject: 'Subject',
			textBody: 'text',
			htmlBody: '<p>html</p>',
			messageId: '<m@example.com>',
			timestamp: 1_699_000_000_000,
			inReplyTo: '<p@example.com>',
			references: '<r@example.com>',
		});

		expect(mail).toEqual({
			from: 'a@example.com',
			to: 'b@example.com',
			subject: 'Subject',
			textBody: 'text',
			htmlBody: '<p>html</p>',
			headers: {},
			messageId: '<m@example.com>',
			inReplyTo: '<p@example.com>',
			references: '<r@example.com>',
			attachments: [],
			timestamp: 1_699_000_000_000,
		});
	});

	it('defaults the three required strings and empties the two collections', () => {
		const mail = resend.parseInbound({ timestamp: 7 });

		expect(mail.from).toBe('');
		expect(mail.to).toBe('');
		expect(mail.subject).toBe('');
		expect(mail.headers).toEqual({});
		expect(mail.attachments).toEqual([]);
		expect(mail.textBody).toBeUndefined();
		expect(mail.htmlBody).toBeUndefined();
	});

	it('falls the message id back to the SAME timestamp it reports', () => {
		// The subtle half of the old two-step: the fallback interpolated the
		// already-defaulted timestamp, not the raw one, so `messageId` and
		// `timestamp` can never name two different clocks.
		const mail = resend.parseInbound({ timestamp: 99 });

		expect(mail.messageId).toBe('unknown-99');
		expect(mail.timestamp).toBe(99);
	});

	it('stamps the receive clock when the payload carries no timestamp', () => {
		const before = Date.now();
		const mail = resend.parseInbound({});
		const after = Date.now();

		expect(mail.timestamp).toBeGreaterThanOrEqual(before);
		expect(mail.timestamp).toBeLessThanOrEqual(after);
		expect(mail.messageId).toBe(`unknown-${mail.timestamp}`);
	});

	it('keeps a zero timestamp as zero rather than restamping it', () => {
		// `?? Date.now()` and `|| Date.now()` differ exactly here, and the old
		// composition used the nullish form at both steps.
		const mail = resend.parseInbound({ timestamp: 0 });

		expect(mail.timestamp).toBe(0);
		expect(mail.messageId).toBe('unknown-0');
	});
});

// =============================================================================
// Bucket 3 — the registry: lookup
// =============================================================================
describe('inbound channel adapter registry', () => {
	it('returns an adapter whose declared source matches the lookup key', () => {
		for (const source of ['mta', 'resend'] as const) {
			expect(getInboundChannelAdapter(source).source).toBe(source);
		}
	});
});
