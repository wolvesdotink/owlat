/**
 * Audit PR-03 — forged-DSN suppression poisoning, integration level.
 *
 * RFC 5321: anyone can submit a DSN, and `onMailFrom` skips SPF for the empty
 * null-sender return-path that genuine DSNs use. So an attacker who guesses or
 * leaks a `messageId` could previously hand-craft `bounce+<b64url(id)>@` and
 * have a healthy recipient blocklisted. With BOUNCE_VERP_KEY set, the MTA only
 * attributes (and therefore only emits a `bounced` suppression event for) a
 * token it actually signed.
 *
 * These tests run the REAL `parseVerpAddress` + `parseBounce` + the classify
 * pipeline phase + the bounce reducer (only the logger is stubbed) with a
 * signing key configured, and assert:
 *   (b) `parseBounce` drops an unsigned `bounce+<validid>@` DSN as unattributed
 *       and increments the unattributed counter.
 *   (d) the pipeline+reducer emit NO `notify_convex` `bounced` effect for that
 *       forged unsigned DSN — even though the (correctly-signed) token for the
 *       same send WOULD have suppressed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { ParsedMail } from 'mailparser';
import { parseBounce, getUnattributedBounceCount } from '../parser.js';
import { buildVerpAddress } from '../verp.js';
import { parseFblOrDsnPhase } from '../phases/parseFblOrDsn.js';
import { reduce } from '../outcome.js';
import type { BasePhaseCtx, PhaseDeps } from '../types.js';
import type { BounceAttempt } from '../types.js';

const KEY = 'integration-verp-key-abcdef0123456789';
const RETURN_PATH_DOMAIN = 'bounces.owlat.test';
const messageId = 'send_existingSendRow0123456789';

/**
 * The forged envelope an attacker can build WITHOUT the signing key: a valid
 * base64url(messageId) and NO MAC. Constructed by hand (not via
 * buildVerpAddress, which would sign it once BOUNCE_VERP_KEY is set) so it
 * faithfully models the attacker's capability.
 */
function forgedUnsignedRcpt(): string {
	return `bounce+${Buffer.from(messageId).toString('base64url')}@${RETURN_PATH_DOMAIN}`;
}

/** A minimal RFC 3464 hard-bounce DSN for `user@remote.test`. */
function hardBounceDsn(): ParsedMail {
	return {
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
		headers: new Map(),
		attachments: [],
	} as unknown as ParsedMail;
}

/**
 * A forged hard-bounce DSN that smuggles the attacker's guessed messageId via
 * the unauthenticated `X-Owlat-Message-Id` header — once in the human-readable
 * text body (step 3 of parseBounce) and once in a `message/rfc822` attachment
 * (step 2). Genuine DSNs echo our outbound headers back, so this header is fully
 * attacker-controllable on a forged null-sender report. With a key configured,
 * NEITHER path may attribute the bounce.
 */
function forgedHeaderBounceDsn(): ParsedMail {
	return {
		subject: 'Delivery Status Notification (Failure)',
		from: { text: 'MAILER-DAEMON@mx.remote.test' },
		text: [
			'Reporting-MTA: dns; mx.remote.test',
			'',
			'Final-Recipient: rfc822; user@remote.test',
			'Action: failed',
			'Status: 5.1.1',
			'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
			`X-Owlat-Message-Id: ${messageId}`,
		].join('\n'),
		headers: new Map(),
		attachments: [
			{
				contentType: 'message/rfc822',
				content: Buffer.from(
					[
						`X-Owlat-Message-Id: ${messageId}`,
						'Subject: original',
						'',
						'body',
					].join('\n'),
					'utf-8',
				),
			},
		],
	} as unknown as ParsedMail;
}

beforeEach(() => {
	process.env['BOUNCE_VERP_KEY'] = KEY;
});

afterEach(() => {
	delete process.env['BOUNCE_VERP_KEY'];
});

describe('forged-DSN suppression poisoning (audit PR-03)', () => {
	it('(b) parseBounce drops an UNSIGNED bounce+<validid>@ DSN as unattributed and increments the counter', () => {
		// The forged envelope: a valid base64url(messageId) but NO MAC — exactly
		// what an attacker can construct from a leaked/guessed id.
		const forgedRcpt = forgedUnsignedRcpt();

		const before = getUnattributedBounceCount();
		const result = parseBounce(hardBounceDsn(), forgedRcpt);

		// No attributable messageId → null (cannot be used to suppress).
		expect(result).toBeNull();
		// And it is counted as unattributed for monitoring.
		expect(getUnattributedBounceCount()).toBe(before + 1);
	});

	it('(b) parseBounce DOES attribute a correctly-signed token for the same send', () => {
		const signedRcpt = buildVerpAddress(messageId, RETURN_PATH_DOMAIN, KEY);
		const result = parseBounce(hardBounceDsn(), signedRcpt);
		expect(result).not.toBeNull();
		expect(result!.originalMessageId).toBe(messageId);
		expect(result!.bounceType).toBe('hard');
	});

	it('(d) a forged UNSIGNED DSN for an existing send produces NO notify_convex "bounced" effect', async () => {
		const deps: PhaseDeps = { redis: {} as never, config: {} as never };
		const forgedRcpt = forgedUnsignedRcpt();

		const ctx: BasePhaseCtx = {
			parsed: hardBounceDsn(),
			rawBuffer: Buffer.alloc(0),
			rcptTo: forgedRcpt,
		};

		const out = await parseFblOrDsnPhase.run(deps, ctx);

		// The forged unsigned token cannot be authenticated, so parseBounce yields
		// no attributable messageId: the classify phase never emits a
		// `dsn_attributed`. (It either `continue`s to routing — which terminates as
		// `unrecognized`/`route_*`/`mailbox` — or, if it ever classified, would be
		// `dsn_unattributed`.) Crucially: NOT `dsn_attributed`.
		if (out.kind === 'bounceTo') {
			const attempt = (out as { kind: 'bounceTo'; attempt: BounceAttempt }).attempt;
			expect(attempt.kind).not.toBe('dsn_attributed');
			// Reducing whatever terminal attempt arose emits no suppression event.
			const { effects } = reduce(attempt, ctx);
			const bouncedNotify = effects.filter(
				(e) => e.kind === 'notify_convex' && e.event.event === 'bounced',
			);
			expect(bouncedNotify).toHaveLength(0);
		} else {
			// `continue` → routing phases own the rest; none of them can emit a
			// `bounced` event (only `dsn_attributed` does). The forged DSN is inert.
			expect(out.kind).toBe('continue');
		}
	});

	it('(e) parseBounce drops a forged DSN that smuggles X-Owlat-Message-Id via header (body + attachment) when a key is set', () => {
		// Attacker rcpt: not a signed VERP token (any address — here a bare bounce
		// domain), so step 1 yields null. The forged DSN then carries the guessed
		// messageId in BOTH the text body and a message/rfc822 attachment. With a
		// key configured, the header-scrape fallbacks (steps 2 and 3) MUST be
		// skipped, so no attribution happens.
		const before = getUnattributedBounceCount();
		const result = parseBounce(forgedHeaderBounceDsn(), `noreply@${RETURN_PATH_DOMAIN}`);

		expect(result).toBeNull();
		expect(getUnattributedBounceCount()).toBe(before + 1);
	});

	it('(e) the same header-smuggling forged DSN produces NO notify_convex "bounced" effect through the phase + reducer', async () => {
		const deps: PhaseDeps = { redis: {} as never, config: {} as never };

		const ctx: BasePhaseCtx = {
			parsed: forgedHeaderBounceDsn(),
			rawBuffer: Buffer.alloc(0),
			rcptTo: `noreply@${RETURN_PATH_DOMAIN}`,
		};

		const out = await parseFblOrDsnPhase.run(deps, ctx);

		if (out.kind === 'bounceTo') {
			const attempt = (out as { kind: 'bounceTo'; attempt: BounceAttempt }).attempt;
			expect(attempt.kind).not.toBe('dsn_attributed');
			const { effects } = reduce(attempt, ctx);
			const bouncedNotify = effects.filter(
				(e) => e.kind === 'notify_convex' && e.event.event === 'bounced',
			);
			expect(bouncedNotify).toHaveLength(0);
		} else {
			expect(out.kind).toBe('continue');
		}
	});

	it('(e) WITHOUT a key, the legacy header-scrape fallback still attributes (backward-compatible)', () => {
		// Sanity check that the gate is key-conditional: with no signing key the
		// header fallback remains active so existing unsigned deployments keep
		// attributing DSNs that only carry the X-Owlat-Message-Id header.
		delete process.env['BOUNCE_VERP_KEY'];
		const result = parseBounce(forgedHeaderBounceDsn(), `noreply@${RETURN_PATH_DOMAIN}`);
		expect(result).not.toBeNull();
		expect(result!.originalMessageId).toBe(messageId);
	});

	it('(d) a correctly-signed DSN for the same existing send DOES produce a notify_convex "bounced" effect', async () => {
		const deps: PhaseDeps = { redis: {} as never, config: {} as never };
		const signedRcpt = buildVerpAddress(messageId, RETURN_PATH_DOMAIN, KEY);

		const ctx: BasePhaseCtx = {
			parsed: hardBounceDsn(),
			rawBuffer: Buffer.alloc(0),
			rcptTo: signedRcpt,
		};

		const out = await parseFblOrDsnPhase.run(deps, ctx);
		expect(out.kind).toBe('bounceTo');
		const attempt = (out as { kind: 'bounceTo'; attempt: BounceAttempt }).attempt;
		expect(attempt.kind).toBe('dsn_attributed');

		const { effects } = reduce(attempt, ctx);
		const bouncedNotify = effects.filter(
			(e) => e.kind === 'notify_convex' && e.event.event === 'bounced',
		);
		expect(bouncedNotify).toHaveLength(1);
		expect(
			bouncedNotify[0]!.kind === 'notify_convex' && bouncedNotify[0]!.event.messageId,
		).toBe(messageId);
	});
});
