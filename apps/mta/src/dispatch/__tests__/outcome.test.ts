import { describe, it, expect } from 'vitest';
import { classifyResult, reduce, type DispatchOutcome } from '../outcome.js';
import { classifySmtpResponse } from '../../intelligence/smtpClassifier.js';
import type { AttemptCtx } from '../types.js';
import type { EmailJob, EmailJobResult } from '../../types.js';

function makeJob(overrides: Partial<EmailJob> = {}): EmailJob {
	return {
		messageId: 'msg-001',
		to: 'user@example.com',
		from: 'sender@owlat.com',
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'owlat.com',
		...overrides,
	};
}

function makeCtx(overrides: Partial<AttemptCtx> = {}): AttemptCtx {
	const job = overrides.job ?? makeJob();
	return {
		job,
		domain: 'example.com',
		destination: {
			recipientDomain: 'example.com',
			providerKey: 'other',
			throttleKey: 'example.com',
			mx: {
				status: 'deliverable',
				source: 'mx',
				hosts: [{ exchange: 'mx.example.com', priority: 0 }],
			},
			daneDiscoveryAuthenticated: true,
		},
		fromDomain: 'owlat.com',
		pool: 'transactional',
		dedicatedIp: undefined,
		ip: '10.0.0.1',
		durationMs: 421,
		...overrides,
	};
}

describe('classifyResult', () => {
	it('success → delivered', () => {
		const result: EmailJobResult = {
			success: true,
			smtpCode: 250,
			smtpResponse: 'Queued',
			remoteMessageId: '<remote@isp>',
			enhancedCode: '2.0.0',
		};
		expect(classifyResult(result)).toEqual({
			kind: 'delivered',
			smtpCode: 250,
			smtpResponse: 'Queued',
			remoteMessageId: '<remote@isp>',
			enhancedCode: '2.0.0',
		});
	});

	it('delivered defaults smtpCode to 250 when missing', () => {
		const out = classifyResult({ success: true });
		expect(out.kind).toBe('delivered');
		if (out.kind === 'delivered') expect(out.smtpCode).toBe(250);
	});

	it('bounceType=hard → hard_bounce', () => {
		const out = classifyResult({
			success: false,
			bounceType: 'hard',
			smtpCode: 550,
			error: 'User unknown',
			enhancedCode: '5.1.1',
		});
		expect(out.kind).toBe('hard_bounce');
		if (out.kind === 'hard_bounce') {
			expect(out.smtpCode).toBe(550);
			expect(out.error).toBe('User unknown');
		}
	});

	it('hard_bounce defaults smtpCode to 550', () => {
		const out = classifyResult({ success: false, bounceType: 'hard', error: 'x' });
		expect(out.kind).toBe('hard_bounce');
		if (out.kind === 'hard_bounce') expect(out.smtpCode).toBe(550);
	});

	it('bounceType=deferred → deferred with classification', () => {
		const out = classifyResult({
			success: false,
			bounceType: 'deferred',
			smtpCode: 421,
			error: 'Greylisted, try again in 60 seconds',
		});
		expect(out.kind).toBe('deferred');
		if (out.kind === 'deferred') {
			expect(out.smtpCode).toBe(421);
			expect(out.classification.category).toBe('greylisted');
			expect(out.classification.suggestedDelayMs).toBeGreaterThan(0);
		}
	});

	it('failure without bounceType → soft_bounce', () => {
		const out = classifyResult({ success: false, error: 'Connection refused' });
		expect(out).toEqual({ kind: 'soft_bounce', error: 'Connection refused' });
	});

	// W8 AMBIGUOUS_TIMEOUT: the post-DATA drop gets its OWN discriminated arm — it
	// must NOT collapse into hard_bounce (no fabricated smtpCode, no suppression).
	it('bounceType=ambiguous → ambiguous (never hard_bounce)', () => {
		const out = classifyResult({
			success: false,
			bounceType: 'ambiguous',
			error: 'connection dropped after DATA',
		});
		expect(out).toEqual({ kind: 'ambiguous', error: 'connection dropped after DATA' });
		expect(out.kind).not.toBe('hard_bounce');
	});
});

describe('reduce(delivered)', () => {
	const outcome: DispatchOutcome = {
		kind: 'delivered',
		smtpCode: 250,
		smtpResponse: 'Queued',
		remoteMessageId: '<remote@isp>',
		enhancedCode: '2.0.0',
	};

	it('produces the canonical 8-effect list and no defer', () => {
		const { effects, defer } = reduce(outcome, makeCtx());
		expect(defer).toBeUndefined();
		expect(effects.map((e) => e.kind)).toEqual([
			'domain_throttle_success',
			'circuit_breaker_outcome',
			'smtp_response',
			'warming_record',
			'metrics_record',
			'domain_failure_clear',
			'log_delivery_event',
			'notify_convex',
		]);
	});

	it('emits the email.sent notify_convex event', () => {
		const { effects } = reduce(outcome, makeCtx());
		const notify = effects.find((e) => e.kind === 'notify_convex');
		expect(notify).toBeDefined();
		if (notify?.kind === 'notify_convex') {
			expect(notify.event.event).toBe('sent');
			expect(notify.event.messageId).toBe('msg-001');
			expect(notify.event.organizationId).toBe('org-1');
			expect(notify.event.recipient).toBe('user@example.com');
			expect(notify.event.destinationProvider).toBe('other');
			expect(notify.event.remoteMessageId).toBe('<remote@isp>');
		}
	});

	// PR-15: a delivery for a campaign-stream job bumps the per-campaign
	// delivered counter — the denominator for the bounce-side complaint rate.
	it('emits campaign_delivery_record when the job carries a campaign Feedback-ID', () => {
		// A realistic Convex doc id (the parser now rejects non-id-shaped values).
		const campaignId = 'jh71d9k2m3n4p5q6r7s8t9v0w1x2y3z4';
		const job = makeJob({ headers: { 'Feedback-ID': `campaign:${campaignId}:topic:ab12cd` } });
		const { effects } = reduce(outcome, makeCtx({ job }));
		const record = effects.find((e) => e.kind === 'campaign_delivery_record');
		expect(record).toEqual({ kind: 'campaign_delivery_record', campaignId });
	});

	it('does NOT emit campaign_delivery_record for a txn Feedback-ID', () => {
		const job = makeJob({ headers: { 'Feedback-ID': 'txn:none:none:ab12cd' } });
		const { effects } = reduce(outcome, makeCtx({ job }));
		expect(effects.some((e) => e.kind === 'campaign_delivery_record')).toBe(false);
	});

	it('does NOT emit campaign_delivery_record when the job has no headers', () => {
		const { effects } = reduce(outcome, makeCtx());
		expect(effects.some((e) => e.kind === 'campaign_delivery_record')).toBe(false);
	});
});

describe('reduce(hard_bounce)', () => {
	const outcome: DispatchOutcome = {
		kind: 'hard_bounce',
		smtpCode: 550,
		error: 'User unknown',
		enhancedCode: '5.1.1',
	};

	it('produces the canonical 8-effect list with suppress_recipient last and no defer', () => {
		const { effects, defer } = reduce(outcome, makeCtx());
		expect(defer).toBeUndefined();
		expect(effects.map((e) => e.kind)).toEqual([
			'circuit_breaker_outcome',
			'smtp_response',
			'domain_throttle_reject',
			'warming_record',
			'metrics_record',
			'log_delivery_event',
			'notify_convex',
			'suppress_recipient',
		]);
	});

	it('suppress_recipient targets the recipient with hard_bounce reason', () => {
		const { effects } = reduce(outcome, makeCtx());
		const suppress = effects.find((e) => e.kind === 'suppress_recipient');
		expect(suppress).toEqual({
			kind: 'suppress_recipient',
			address: 'user@example.com',
			reason: 'hard_bounce',
		});
	});

	it('notify_convex carries bounceType: hard', () => {
		const { effects } = reduce(outcome, makeCtx());
		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind === 'notify_convex') {
			expect(notify.event.event).toBe('bounced');
			expect(notify.event.bounceType).toBe('hard');
		}
	});
});

describe('member test delivery effect isolation', () => {
	it.each([
		{
			kind: 'delivered',
			smtpCode: 250,
			smtpResponse: 'Queued',
			enhancedCode: '2.0.0',
		} as const,
		{
			kind: 'hard_bounce',
			smtpCode: 550,
			error: 'No such user',
			enhancedCode: '5.1.1',
		} as const,
	])('retains lifecycle/log evidence but no production state for $kind', (outcome) => {
		const job = makeJob({ deliveryDomain: 'member_test' });
		const { effects } = reduce(outcome, makeCtx({ job }));
		expect(effects.map((effect) => effect.kind)).toEqual(['log_delivery_event', 'notify_convex']);
		const notify = effects.find((effect) => effect.kind === 'notify_convex');
		expect(notify).toMatchObject({
			kind: 'notify_convex',
			event: { messageId: 'msg-001', deliveryDomain: 'member_test' },
		});
		if (notify?.kind === 'notify_convex') {
			expect(notify.event.recipient).toBeUndefined();
			expect(notify.event.destinationProvider).toBeUndefined();
			expect(notify.event.primarySendingDomain).toBeUndefined();
		}
	});
});

describe('reduce(deferred)', () => {
	it('produces the canonical 5-effect list (no notify_convex) plus a defer from the classification', () => {
		const outcome: DispatchOutcome = {
			kind: 'deferred',
			smtpCode: 421,
			error: 'Try again in 120 seconds',
			enhancedCode: undefined,
			classification: {
				category: 'greylisted',
				retryable: true,
				suggestedDelayMs: 120_000,
				countAsBounce: false,
			},
		};

		const { effects, defer } = reduce(outcome, makeCtx());
		expect(effects.map((e) => e.kind)).toEqual([
			'domain_throttle_defer',
			'smtp_response',
			'warming_record',
			'metrics_record',
			'log_delivery_event',
		]);
		expect(defer).toEqual({
			delayMs: 120_000,
			reason: expect.stringContaining('greylisted'),
		});
	});
});

describe('reduce(deferred) — non-retryable classification', () => {
	// A 4xx that the classifier marks `retryable: false` (e.g. a 451 rejected
	// under a spam policy) must NOT keep deferring — that loops the job toward
	// the dead-letter queue. It must drop terminally with a hard-bounce-style
	// effect set. RFC 6647 / RFC 5321 §4.2.1.
	function deferredNonRetryable(): DispatchOutcome {
		const error = '451 Message rejected due to spam policy';
		return {
			kind: 'deferred',
			smtpCode: 451,
			error,
			enhancedCode: undefined,
			classification: classifySmtpResponse(451, error, undefined),
		};
	}

	it('classifies a 451 spam-policy rejection as non-retryable', () => {
		const outcome = deferredNonRetryable();
		if (outcome.kind === 'deferred') {
			expect(outcome.classification.retryable).toBe(false);
		}
	});

	it('drops terminally (defer: undefined) instead of re-deferring', () => {
		const { defer } = reduce(deferredNonRetryable(), makeCtx());
		expect(defer).toBeUndefined();
	});

	it('emits a terminal hard-bounce effect set with suppress_recipient last', () => {
		const { effects } = reduce(deferredNonRetryable(), makeCtx());
		expect(effects.map((e) => e.kind)).toEqual([
			'circuit_breaker_outcome',
			'smtp_response',
			'domain_throttle_reject',
			'warming_record',
			'metrics_record',
			'log_delivery_event',
			'notify_convex',
			'suppress_recipient',
		]);
		const suppress = effects.find((e) => e.kind === 'suppress_recipient');
		expect(suppress).toEqual({
			kind: 'suppress_recipient',
			address: 'user@example.com',
			reason: 'hard_bounce',
		});
		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind === 'notify_convex') {
			expect(notify.event.event).toBe('bounced');
			expect(notify.event.bounceType).toBe('hard');
		}
	});

	it('still re-defers a retryable greylist deferral (regression guard)', () => {
		const error = 'Greylisted, try again in 90 seconds';
		const outcome: DispatchOutcome = {
			kind: 'deferred',
			smtpCode: 450,
			error,
			enhancedCode: undefined,
			classification: classifySmtpResponse(450, error, undefined),
		};
		const { defer, effects } = reduce(outcome, makeCtx());
		expect(defer).toBeDefined();
		expect(effects[0]?.kind).toBe('domain_throttle_defer');
	});
});

describe('classifySmtpResponse — retry-delay regression guards', () => {
	it("'421 too many connections' → rate_limited with a 900000ms delay", () => {
		const c = classifySmtpResponse(421, '421 too many connections', undefined);
		expect(c.category).toBe('rate_limited');
		expect(c.retryable).toBe(true);
		expect(c.suggestedDelayMs).toBe(900_000);
	});

	it("'450 try again in 90 seconds' → greylisted with a ~90000ms delay", () => {
		const c = classifySmtpResponse(450, '450 try again in 90 seconds', undefined);
		expect(c.category).toBe('greylisted');
		expect(c.retryable).toBe(true);
		expect(c.suggestedDelayMs).toBe(90_000);
	});
});

describe('reduce(soft_bounce)', () => {
	it('produces the canonical 6-effect list plus a 60s defer', () => {
		const outcome: DispatchOutcome = { kind: 'soft_bounce', error: 'Connection refused' };

		const { effects, defer } = reduce(outcome, makeCtx());
		expect(effects.map((e) => e.kind)).toEqual([
			'circuit_breaker_outcome',
			'warming_record',
			'domain_failure_record',
			'metrics_record',
			'log_delivery_event',
			'notify_convex',
		]);
		expect(defer).toEqual({
			delayMs: 60_000,
			reason: expect.stringContaining('Soft bounce'),
		});
	});

	it('notify_convex carries bounceType: soft', () => {
		const outcome: DispatchOutcome = { kind: 'soft_bounce', error: 'Connection refused' };
		const { effects } = reduce(outcome, makeCtx());
		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind === 'notify_convex') {
			expect(notify.event.bounceType).toBe('soft');
		}
	});
});

describe('reduce(ambiguous)', () => {
	// W8/I2: the post-DATA ambiguous drop is TERMINAL (no defer, no next-MX) but
	// must NOT be a bounce — the message may have been delivered. The reducer
	// emits neither suppression, a synthetic 5xx smtp_response, nor any
	// reputation penalty (circuit-breaker / throttle-reject / warming-bounce /
	// bounced notify_convex). It DOES notify Convex with a terminal, non-bounce
	// `failed` event so the message row leaves "sending".
	const outcome: DispatchOutcome = {
		kind: 'ambiguous',
		error: 'Ambiguous delivery outcome (phase data-final, no server reply)',
	};

	it('is terminal (defer: undefined) — never requeued', () => {
		const { defer } = reduce(outcome, makeCtx());
		expect(defer).toBeUndefined();
	});

	it('emits a neutral metric + delivery log + a terminal failed notify — no suppression', () => {
		const { effects } = reduce(outcome, makeCtx());
		expect(effects.map((e) => e.kind)).toEqual([
			'metrics_record',
			'log_delivery_event',
			'notify_convex',
		]);
	});

	it('does NOT suppress the recipient', () => {
		const { effects } = reduce(outcome, makeCtx());
		expect(effects.some((e) => e.kind === 'suppress_recipient')).toBe(false);
	});

	it('does NOT fabricate an smtp_response (no reply was received)', () => {
		const { effects } = reduce(outcome, makeCtx());
		expect(effects.some((e) => e.kind === 'smtp_response')).toBe(false);
	});

	it('does NOT penalise reputation (no circuit-breaker bounce, throttle-reject, or warming-bounce)', () => {
		const { effects } = reduce(outcome, makeCtx());
		expect(effects.some((e) => e.kind === 'circuit_breaker_outcome')).toBe(false);
		expect(effects.some((e) => e.kind === 'domain_throttle_reject')).toBe(false);
		expect(effects.some((e) => e.kind === 'warming_record')).toBe(false);
	});

	it('notifies Convex with a terminal `failed` event — NOT `bounced`, and no bounceType', () => {
		const { effects } = reduce(outcome, makeCtx());
		const notify = effects.find((e) => e.kind === 'notify_convex');
		expect(notify).toBeDefined();
		if (notify?.kind === 'notify_convex') {
			expect(notify.event.event).toBe('failed');
			expect(notify.event.event).not.toBe('bounced');
			expect(notify.event.bounceType).toBeUndefined();
			expect(notify.event.messageId).toBe(makeJob().messageId);
			expect(notify.event.organizationId).toBe(makeJob().organizationId);
			expect(notify.event.severity).toBe('warning');
		}
	});

	it('records the metric as a neutral error, not a bounce', () => {
		const { effects } = reduce(outcome, makeCtx());
		const m = effects.find((e) => e.kind === 'metrics_record');
		if (m?.kind === 'metrics_record') {
			expect(m.outcome).toBe('error');
		}
	});

	it('logs a terminal failed event tagged ambiguous_post_data', () => {
		const { effects } = reduce(outcome, makeCtx());
		const log = effects.find((e) => e.kind === 'log_delivery_event');
		if (log?.kind === 'log_delivery_event') {
			expect(log.event.status).toBe('failed');
			expect(log.event.reason).toBe('ambiguous_post_data');
		}
	});
});

describe('reduce — shared invariants', () => {
	it('metrics_record uses job.ipPool (the requested pool), not the resolved pool', () => {
		const job = makeJob({ ipPool: 'campaign' });
		const ctx = makeCtx({ job, pool: 'transactional' });
		const outcome: DispatchOutcome = {
			kind: 'delivered',
			smtpCode: 250,
			smtpResponse: undefined,
			remoteMessageId: undefined,
			enhancedCode: undefined,
		};

		const { effects } = reduce(outcome, ctx);
		const m = effects.find((e) => e.kind === 'metrics_record');
		if (m?.kind === 'metrics_record') {
			// Matches pre-deepening handler at lines 191, 239, 292, 329 — all
			// pass `job.ipPool`, not the resolved pool, to metrics.record.
			expect(m.pool).toBe('campaign');
		}
	});

	it('log_delivery_event uses the resolved pool (matches handler:206, 254, 305, 342)', () => {
		const job = makeJob({ ipPool: 'campaign' });
		const ctx = makeCtx({ job, pool: 'transactional' });
		const outcome: DispatchOutcome = {
			kind: 'delivered',
			smtpCode: 250,
			smtpResponse: undefined,
			remoteMessageId: undefined,
			enhancedCode: undefined,
		};

		const { effects } = reduce(outcome, ctx);
		const log = effects.find((e) => e.kind === 'log_delivery_event');
		if (log?.kind === 'log_delivery_event') {
			expect(log.event.pool).toBe('transactional');
		}
	});
});
