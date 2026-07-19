import { describe, it, expect } from 'vitest';
import type { ParsedMessage } from '@owlat/mail-message';
import { reduce } from '../outcome.js';
import type { BasePhaseCtx, BounceAttempt } from '../types.js';
import type { InboundRoute } from '../../inbound/router.js';
import type { MailboxCacheEntry } from '../../inbound/mailboxResolver.js';
import type { BounceClassification } from '../../types.js';

function makeParsed(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
	return {
		from: { text: 'bob@isp.example', value: [{ address: 'bob@isp.example', name: '' }], html: '' },
		subject: 'hi there',
		text: 'hello body',
		html: '<p>hello body</p>',
		date: new Date('2026-05-17T12:00:00Z'),
		messageId: 'orig-msg-1',
		headers: new Map<string, string>([['from', 'bob@isp.example']]),
		attachments: [],
		...overrides,
	} as unknown as ParsedMessage;
}

function makeCtx(overrides: Partial<BasePhaseCtx> = {}): BasePhaseCtx {
	return {
		parsed: overrides.parsed ?? makeParsed(),
		rawBuffer: overrides.rawBuffer ?? Buffer.from('raw mime bytes'),
		rcptTo: overrides.rcptTo ?? 'inbox@org.example',
		spfResult: overrides.spfResult,
		returnPath: overrides.returnPath,
	};
}

function makeRoute(overrides: Partial<InboundRoute> = {}): InboundRoute {
	return {
		id: 'org.example:inbox',
		domain: 'org.example',
		address: 'inbox',
		mode: 'accept',
		organizationId: 'org-1',
		createdAt: 0,
		...overrides,
	};
}

const arf: BounceClassification = {
	type: 'complained',
	bounceType: 'hard',
	message: 'Spam complaint via ARF from microsoft',
	originalMessageId: 'orig-msg-1',
	organizationId: 'org-1',
};

describe('reduce(fbl) — attributed complaint', () => {
	const attempt: BounceAttempt = { kind: 'fbl', arf };

	it('emits circuit_breaker_outcome + metric_inc + notify_convex + fbl_stats_record', () => {
		const { effects } = reduce(attempt, makeCtx());
		expect(effects.map((e) => e.kind)).toEqual([
			'circuit_breaker_outcome',
			'metric_inc',
			'notify_convex',
			'fbl_stats_record',
		]);
	});

	it('circuit_breaker_outcome targets the org with outcome=complained', () => {
		const { effects } = reduce(attempt, makeCtx());
		const cb = effects.find((e) => e.kind === 'circuit_breaker_outcome');
		expect(cb).toEqual({ kind: 'circuit_breaker_outcome', orgId: 'org-1', outcome: 'complained' });
	});

	it('metric_inc.fbl_complaint extracts isp from the ARF message and marks attributed=yes', () => {
		const { effects } = reduce(attempt, makeCtx());
		const m = effects.find((e) => e.kind === 'metric_inc');
		expect(m).toEqual({
			kind: 'metric_inc',
			metric: 'fbl_complaint',
			isp: 'microsoft',
			attributed: 'yes',
		});
	});

	it('metric_inc.fbl_complaint falls back to isp=unknown when message has no "from" segment', () => {
		const attemptNoIsp: BounceAttempt = {
			kind: 'fbl',
			arf: { ...arf, message: 'Spam complaint' },
		};
		const { effects } = reduce(attemptNoIsp, makeCtx());
		const m = effects.find((e) => e.kind === 'metric_inc');
		if (m?.kind === 'metric_inc' && m.metric === 'fbl_complaint') {
			expect(m.isp).toBe('unknown');
		}
	});

	it('notify_convex carries event=complained with messageId + organizationId', () => {
		const { effects } = reduce(attempt, makeCtx());
		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind === 'notify_convex') {
			expect(notify.event.event).toBe('complained');
			expect(notify.event.messageId).toBe('orig-msg-1');
			expect(notify.event.organizationId).toBe('org-1');
		}
	});

	// PR-15: a complaint that carries a campaign id (from the original message's
	// Feedback-ID) must also enter a PER-CAMPAIGN counter + rate window — not
	// just the per-isp `{isp,attributed}` counter and the flat daily `total`.
	it('emits a per-campaign counter + campaign_complaint_record when arf.campaignId is set', () => {
		const withCampaign: BounceAttempt = { kind: 'fbl', arf: { ...arf, campaignId: 'camp_1' } };
		const { effects } = reduce(withCampaign, makeCtx());

		const perCampaign = effects.find(
			(e) => e.kind === 'metric_inc' && e.metric === 'fbl_complaint_by_campaign'
		);
		expect(perCampaign).toEqual({
			kind: 'metric_inc',
			metric: 'fbl_complaint_by_campaign',
			campaign: 'camp_1',
			isp: 'microsoft',
		});

		const record = effects.find((e) => e.kind === 'campaign_complaint_record');
		expect(record).toEqual({
			kind: 'campaign_complaint_record',
			campaignId: 'camp_1',
			organizationId: 'org-1',
		});
	});

	it('omits the per-campaign effects when arf has no campaignId', () => {
		const { effects } = reduce(attempt, makeCtx());
		expect(effects.some((e) => e.kind === 'campaign_complaint_record')).toBe(false);
		expect(
			effects.some((e) => e.kind === 'metric_inc' && e.metric === 'fbl_complaint_by_campaign')
		).toBe(false);
	});
});

describe('reduce(fbl) — unattributed complaint', () => {
	it('omits circuit_breaker_outcome and notify_convex (no orgId, no messageId)', () => {
		const attempt: BounceAttempt = {
			kind: 'fbl',
			arf: { type: 'complained', bounceType: 'hard', message: 'Spam complaint via ARF from yahoo' },
		};
		const { effects } = reduce(attempt, makeCtx());
		expect(effects.map((e) => e.kind)).toEqual(['metric_inc', 'fbl_stats_record']);
		const m = effects.find((e) => e.kind === 'metric_inc');
		if (m?.kind === 'metric_inc' && m.metric === 'fbl_complaint') {
			expect(m.attributed).toBe('no');
			expect(m.isp).toBe('yahoo');
		}
	});

	// PR-13: a redacted-Message-ID complaint that DOES carry a recipient
	// (RFC 5965 §3.2) must still reach Convex so the complainer is suppressed
	// by email — otherwise the complaint is only a metric and never blocklists.
	it('emits notify_convex carrying the recipient when only a recipient is recoverable', () => {
		const attempt: BounceAttempt = {
			kind: 'fbl',
			arf: {
				type: 'complained',
				bounceType: 'hard',
				message: 'Spam complaint via ARF from google',
				recipient: 'victim@example.com',
			},
		};
		const { effects } = reduce(attempt, makeCtx());
		expect(effects.map((e) => e.kind)).toEqual(['metric_inc', 'notify_convex', 'fbl_stats_record']);
		const m = effects.find((e) => e.kind === 'metric_inc');
		if (m?.kind === 'metric_inc' && m.metric === 'fbl_complaint') {
			// No Message-ID, so it remains unattributed at the metric level.
			expect(m.attributed).toBe('no');
		}
		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind === 'notify_convex') {
			expect(notify.event.event).toBe('complained');
			expect(notify.event.messageId).toBeUndefined();
			expect(notify.event.recipient).toBe('victim@example.com');
		}
	});

	it('prefers the Message-ID and still carries the recipient when both are present', () => {
		const attempt: BounceAttempt = {
			kind: 'fbl',
			arf: { ...arf, recipient: 'victim@example.com' },
		};
		const { effects } = reduce(attempt, makeCtx());
		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind === 'notify_convex') {
			expect(notify.event.messageId).toBe('orig-msg-1');
			expect(notify.event.recipient).toBe('victim@example.com');
		}
	});

	it('emits circuit_breaker_outcome when orgId is present but messageId is not', () => {
		const attempt: BounceAttempt = {
			kind: 'fbl',
			arf: {
				type: 'complained',
				bounceType: 'hard',
				message: 'Spam complaint via ARF from google',
				organizationId: 'org-2',
			},
		};
		const { effects } = reduce(attempt, makeCtx());
		expect(effects.map((e) => e.kind)).toEqual([
			'circuit_breaker_outcome',
			'metric_inc',
			'fbl_stats_record',
		]);
	});

	// PR-15: the gap being closed — a complaint with a campaign id but NO org id
	// (the org-only circuit breaker never sees it) still enters the per-campaign
	// rate window, so it is no longer invisible to rate tracking.
	it('rate-tracks a campaign even when no orgId is extractable', () => {
		const attempt: BounceAttempt = {
			kind: 'fbl',
			arf: {
				type: 'complained',
				bounceType: 'hard',
				message: 'Spam complaint via ARF from yahoo',
				campaignId: 'camp_orphan',
			},
		};
		const { effects } = reduce(attempt, makeCtx());
		// No org → no circuit_breaker_outcome, but the per-campaign tracker fires.
		expect(effects.some((e) => e.kind === 'circuit_breaker_outcome')).toBe(false);
		const record = effects.find((e) => e.kind === 'campaign_complaint_record');
		expect(record).toEqual({
			kind: 'campaign_complaint_record',
			campaignId: 'camp_orphan',
			organizationId: undefined,
		});
		expect(
			effects.some((e) => e.kind === 'metric_inc' && e.metric === 'fbl_complaint_by_campaign')
		).toBe(true);
	});
});

describe('reduce(dsn_attributed)', () => {
	it('emits a single notify_convex event with bounceType', () => {
		const attempt: BounceAttempt = {
			kind: 'dsn_attributed',
			bounce: {
				type: 'bounced',
				bounceType: 'hard',
				message: 'mailbox full',
				originalMessageId: 'orig-1',
				organizationId: 'org-1',
			},
		};
		const { effects } = reduce(attempt, makeCtx());
		expect(effects.map((e) => e.kind)).toEqual(['notify_convex']);
		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind === 'notify_convex') {
			expect(notify.event.event).toBe('bounced');
			expect(notify.event.messageId).toBe('orig-1');
			expect(notify.event.bounceType).toBe('hard');
			expect(notify.event.message).toBe('mailbox full');
		}
	});
});

describe('reduce(dsn_unattributed)', () => {
	it('emits the unattributed_bounce metric only', () => {
		const { effects } = reduce({ kind: 'dsn_unattributed' }, makeCtx());
		expect(effects).toEqual([{ kind: 'metric_inc', metric: 'unattributed_bounce' }]);
	});
});

describe('reduce(mailbox)', () => {
	const mailbox: MailboxCacheEntry = {
		mailboxId: 'mb-1',
		organizationId: 'org-1',
		usedBytes: 100,
		cachedAt: 0,
	};

	it('emits notify_convex (mailbox event) + mailbox_quota_bump', () => {
		const attempt: BounceAttempt = {
			kind: 'mailbox',
			mailbox,
			rcptTo: 'me@org.example',
			attachments: [],
			toAddrs: ['me@org.example'],
			ccAddrs: [],
			bccAddrs: [],
			references: undefined,
			dkimResult: 'pass',
		};
		const { effects } = reduce(attempt, makeCtx({ rcptTo: 'me@org.example' }));
		expect(effects.map((e) => e.kind)).toEqual(['notify_convex', 'mailbox_quota_bump']);
		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind === 'notify_convex') {
			expect(notify.event.event).toBe('inbound.mailbox.received');
			expect(notify.event.organizationId).toBe('org-1');
			expect(notify.event.mailboxPayload?.recipientAddress).toBe('me@org.example');
			expect(notify.event.mailboxPayload?.rawBytesBase64).toBe(
				Buffer.from('raw mime bytes').toString('base64')
			);
			// DKIM verdict computed in onData is threaded through to the payload.
			expect(notify.event.mailboxPayload?.dkimResult).toBe('pass');
		}
		const bump = effects.find((e) => e.kind === 'mailbox_quota_bump');
		expect(bump).toEqual({
			kind: 'mailbox_quota_bump',
			address: 'me@org.example',
			deltaBytes: Buffer.from('raw mime bytes').length,
		});
	});

	it('passes the bare sender address to Convex when From includes a display name', () => {
		const { effects } = reduce(
			mailboxAttempt(),
			makeCtx({
				parsed: makeParsed({
					from: {
						text: 'Bob Example <bob@isp.example>',
						value: [{ address: 'bob@isp.example', name: 'Bob Example' }],
						html: '',
					},
				}),
			})
		);
		const notify = effects.find((effect) => effect.kind === 'notify_convex');
		if (notify?.kind !== 'notify_convex') throw new Error('no notify_convex effect');
		expect(notify.event.mailboxPayload?.from).toBe('bob@isp.example');
	});

	function mailboxAttempt(): BounceAttempt {
		return {
			kind: 'mailbox',
			mailbox,
			rcptTo: 'me@org.example',
			attachments: [],
			toAddrs: ['me@org.example'],
			ccAddrs: [],
			bccAddrs: [],
			references: undefined,
		};
	}

	function mailboxPayloadFor(spfResult: BasePhaseCtx['spfResult']) {
		const { effects } = reduce(mailboxAttempt(), makeCtx({ rcptTo: 'me@org.example', spfResult }));
		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind !== 'notify_convex') throw new Error('no notify_convex effect');
		return notify.event.mailboxPayload;
	}

	// PR-38: the SPF verdict computed in `onMailFrom` was previously discarded —
	// `reduceMailbox` never set `mailboxPayload.spfResult`, leaving the whole
	// auth-result pipeline (Convex storage + folder routing + UI banner) inert.
	it('threads a computed SPF pass onto the mailbox payload (RFC 7208 §2.6)', () => {
		expect(mailboxPayloadFor('pass')?.spfResult).toBe('pass');
	});

	it('surfaces an SPF softfail as softfail (not collapsed to pass/fail)', () => {
		expect(mailboxPayloadFor('softfail')?.spfResult).toBe('softfail');
	});

	it('records an SPF temperror (DNS lookup error) rather than dropping it to undefined', () => {
		expect(mailboxPayloadFor('temperror')?.spfResult).toBe('temperror');
	});

	it('leaves spfResult undefined when SPF was not evaluated', () => {
		expect(mailboxPayloadFor(undefined)?.spfResult).toBeUndefined();
	});

	// PR-45: the SMTP envelope MAIL FROM (return-path) is threaded onto the
	// mailbox payload so the Convex vacation hook can suppress auto-replies to
	// bounces/DSNs (RFC 3834 §2) keyed off the *envelope*, not the spoofable
	// `From:` header. A bounce arrives with `MAIL FROM:<>` (envelope) but a
	// real `From: MAILER-DAEMON` header.
	function mailboxPayloadForReturnPath(returnPath: BasePhaseCtx['returnPath']) {
		// From header is MAILER-DAEMON — proves the loop guard is keyed off the
		// envelope return-path, not this header.
		const parsed = makeParsed({
			from: {
				text: 'MAILER-DAEMON@mx.isp.example',
				value: [{ address: 'MAILER-DAEMON@mx.isp.example', name: 'Mail Delivery System' }],
				html: '',
			},
		} as Partial<ParsedMessage>);
		const { effects } = reduce(
			mailboxAttempt(),
			makeCtx({ parsed, rcptTo: 'me@org.example', returnPath })
		);
		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind !== 'notify_convex') throw new Error('no notify_convex effect');
		return notify.event.mailboxPayload;
	}

	it('surfaces a null SMTP return-path (<>) as the empty string on the mailbox payload', () => {
		const payload = mailboxPayloadForReturnPath('');
		expect(payload?.returnPath).toBe('');
		// The From header still shows the daemon — the guard must not key off it.
		expect(payload?.from).toBe('MAILER-DAEMON@mx.isp.example');
	});

	it('threads a real SMTP return-path through to the mailbox payload', () => {
		expect(mailboxPayloadForReturnPath('alice@isp.example')?.returnPath).toBe('alice@isp.example');
	});

	it('defaults returnPath to the empty string when the envelope sender is absent', () => {
		expect(mailboxPayloadForReturnPath(undefined)?.returnPath).toBe('');
	});
});

describe('reduce(endpoint_forward)', () => {
	it('emits a single forward_to_endpoint effect carrying the route', () => {
		const route = makeRoute({ mode: 'endpoint', endpointUrl: 'https://hook.example' });
		const ctx = makeCtx();
		const { effects } = reduce({ kind: 'endpoint_forward', route, rcptTo: 'me@org.example' }, ctx);
		expect(effects.map((e) => e.kind)).toEqual(['forward_to_endpoint']);
		const fwd = effects.find((e) => e.kind === 'forward_to_endpoint');
		if (fwd?.kind === 'forward_to_endpoint') {
			expect(fwd.route).toBe(route);
			expect(fwd.parsed).toBe(ctx.parsed);
			expect(fwd.rcptTo).toBe('me@org.example');
		}
	});
});

describe('reduce(inbound_accept)', () => {
	it('emits one stage_attachment per attachment with content, plus a single notify_convex with redisKeys', () => {
		const route = makeRoute();
		const attempt: BounceAttempt = {
			kind: 'inbound_accept',
			route,
			rcptTo: 'inbox@org.example',
			attachments: [
				{
					index: 0,
					filename: 'a.pdf',
					contentType: 'application/pdf',
					size: 10,
					contentBase64: 'AAAA',
				},
				{
					index: 1,
					filename: 'b.txt',
					contentType: 'text/plain',
					size: 5,
					contentBase64: undefined,
				},
				{ index: 2, filename: 'c.png', contentType: 'image/png', size: 20, contentBase64: 'BBBB' },
			],
			headers: { from: 'bob@isp.example' },
		};
		const { effects } = reduce(
			attempt,
			makeCtx({
				parsed: makeParsed({
					from: {
						text: 'Bob Example <bob@isp.example>',
						value: [{ address: 'bob@isp.example', name: 'Bob Example' }],
						html: '',
					},
				}),
			})
		);
		expect(effects.map((e) => e.kind)).toEqual([
			'stage_attachment',
			'stage_attachment',
			'notify_convex',
		]);

		const staged = effects.filter((e) => e.kind === 'stage_attachment');
		expect(staged).toEqual([
			{
				kind: 'stage_attachment',
				redisKey: 'mta:inbound-att:orig-msg-1:0',
				contentBase64: 'AAAA',
				ttlSeconds: 3600,
			},
			{
				kind: 'stage_attachment',
				redisKey: 'mta:inbound-att:orig-msg-1:2',
				contentBase64: 'BBBB',
				ttlSeconds: 3600,
			},
		]);

		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind === 'notify_convex') {
			expect(notify.event.event).toBe('inbound.received');
			expect(notify.event.organizationId).toBe('org-1');
			expect(notify.event.inboundPayload?.attachments).toEqual([
				{
					filename: 'a.pdf',
					contentType: 'application/pdf',
					size: 10,
					redisKey: 'mta:inbound-att:orig-msg-1:0',
				},
				{ filename: 'b.txt', contentType: 'text/plain', size: 5, redisKey: undefined },
				{
					filename: 'c.png',
					contentType: 'image/png',
					size: 20,
					redisKey: 'mta:inbound-att:orig-msg-1:2',
				},
			]);
			expect(notify.event.inboundPayload?.headers).toEqual({ from: 'bob@isp.example' });
			expect(notify.event.inboundPayload?.from).toBe('bob@isp.example');
		}
	});

	it('falls back to "unknown" messageId in the redisKey when parsed.messageId is missing', () => {
		const attempt: BounceAttempt = {
			kind: 'inbound_accept',
			route: makeRoute(),
			rcptTo: 'inbox@org.example',
			attachments: [
				{ index: 0, filename: 'x', contentType: 'application/pdf', size: 1, contentBase64: 'AA' },
			],
			headers: {},
		};
		const ctx = makeCtx({ parsed: makeParsed({ messageId: undefined }) });
		const { effects } = reduce(attempt, ctx);
		const staged = effects.find((e) => e.kind === 'stage_attachment');
		if (staged?.kind === 'stage_attachment') {
			expect(staged.redisKey).toBe('mta:inbound-att:unknown:0');
		}
	});
});

describe('reduce(route_hold | route_bounce | unrecognized)', () => {
	it.each([
		[
			'route_hold',
			{ kind: 'route_hold', route: makeRoute({ mode: 'hold' }), rcptTo: 'x@y.z' } as BounceAttempt,
		],
		[
			'route_bounce',
			{
				kind: 'route_bounce',
				route: makeRoute({ mode: 'bounce' }),
				rcptTo: 'x@y.z',
			} as BounceAttempt,
		],
		['unrecognized', { kind: 'unrecognized', rcptTo: 'x@y.z' } as BounceAttempt],
	])('%s emits no effects', (_label, attempt) => {
		const { effects } = reduce(attempt, makeCtx());
		expect(effects).toEqual([]);
	});
});
