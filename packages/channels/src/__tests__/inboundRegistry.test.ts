/**
 * The inbound normalization contract — the whole of what this package is after
 * the D10 honesty pass.
 *
 * Two things are pinned here. First the translation itself: what each
 * registered source turns a raw envelope into, field by field, including the
 * fallbacks that only fire on a malformed payload and the auth verdicts that
 * must stay *absent* rather than become a pass. Second the package's public
 * surface, which is now inbound-only — the bidirectional `ChannelAdapter` half
 * (a `send` that hard-returned failure, a `healthCheck` that hard-returned
 * healthy, a `validateSignature` that hard-returned `true`) is gone, and this
 * suite fails if any of it comes back.
 */

import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as channels from '../index';
import {
	getInboundChannelAdapter,
	registerInboundChannelAdapter,
	type InboundChannelAdapter,
	type InboundEmailMessage,
	type InboundSource,
} from '../index';

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
// Bucket 3 — the registry: lookup, loud failure, registration
// =============================================================================
describe('inbound channel adapter registry', () => {
	it('returns an adapter whose declared source matches the lookup key', () => {
		for (const source of ['mta', 'resend'] as const) {
			expect(getInboundChannelAdapter(source).source).toBe(source);
		}
	});

	it('throws for a registered-but-unimplemented source, naming it and the fix', () => {
		expect(() => getInboundChannelAdapter('postmark')).toThrow(/postmark/);
		expect(() => getInboundChannelAdapter('postmark')).toThrow(/registerInboundChannelAdapter/);
	});

	it('accepts a new source without any edit to the lookup', () => {
		const source: InboundSource = 'mailgun';
		const stub: InboundChannelAdapter = {
			source,
			parseInbound: (): InboundEmailMessage => ({
				from: 'mg@example.com',
				to: 'inbox@owlat.test',
				subject: 'from mailgun',
				headers: {},
				messageId: 'mg-1',
				attachments: [],
				timestamp: 1,
			}),
		};

		expect(() => getInboundChannelAdapter(source)).toThrow();

		// The registry is module-level state and there is no unregister; vitest
		// gives each test FILE its own module instance, so this mutation is
		// confined here. Keep it the last case that reads the registry.
		registerInboundChannelAdapter(stub);

		expect(getInboundChannelAdapter(source)).toBe(stub);
		expect(getInboundChannelAdapter(source).parseInbound({}).messageId).toBe('mg-1');
	});
});

// =============================================================================
// Bucket 4 — the honesty gate: the surface is inbound-only
//
// These fail against the pre-D10 package, which is the point: they are what
// stops the stub adapters from being re-added, or a new one from being written
// against a `ChannelAdapter` interface that no longer has a home here.
// =============================================================================
describe('package surface', () => {
	it('exports exactly the inbound registry, and nothing that sends', () => {
		expect(Object.keys(channels).sort()).toEqual([
			'MtaInboundAdapter',
			'ResendInboundAdapter',
			'getInboundChannelAdapter',
			'registerInboundChannelAdapter',
		]);
	});

	it('ships exactly the two inbound modules', () => {
		const modules = readdirSync(new URL('..', import.meta.url))
			.filter((entry) => entry.endsWith('.ts'))
			.sort();

		expect(modules).toEqual(['inboundRegistry.ts', 'index.ts']);
	});
});
