import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests for the Webhook dispatcher's routing table.
 *
 * The dispatcher is pure orchestration: it picks a handler by event kind and
 * forwards to a downstream mutation via `ctx.runMutation` (or, for IP events,
 * `ctx.scheduler.runAfter`). We exercise the routing logic without the
 * convex-test harness by:
 *   - mocking `_generated/api` so `internal.*` references resolve to stable,
 *     comparable path strings (the real `anyApi` proxy returns a fresh,
 *     non-serializable object on every access, so identity/`toString` are
 *     unusable);
 *   - passing a hand-rolled mock `ActionCtx` and asserting on which reference +
 *     args each handler dispatches.
 */

// Recursive proxy that turns any `internal.a.b.c` access into the path string
// "internal.a.b.c". Both the dispatcher under test and this test file import
// the same mocked module, so a handler's `internal.foo.bar` and the test's
// `internal.foo.bar` compare equal by value.
vi.mock('../../_generated/api', () => {
	const makeRef = (path: string): unknown =>
		new Proxy(
			{},
			{
				get(_t, prop: string | symbol) {
					// Symbols (incl. Symbol.toPrimitive) get undefined, so string
					// coercion falls through to `toString`, which yields the path.
					if (typeof prop === 'symbol') return undefined;
					if (prop === 'toString') return () => path;
					return makeRef(`${path}.${prop}`);
				},
			}
		);
	return { internal: makeRef('internal'), api: makeRef('api') };
});

import { internal } from '../../_generated/api';
import { dispatchInboundEvent } from '../dispatcher';
import type { InboundEvent } from '../types';
import type { ActionCtx } from '../../_generated/server';

// A reference string for an `internal.*` mutation, derived through the same
// mock the dispatcher sees. The mock leaves are proxies whose `toString`
// returns the path; coercing to a template string yields the comparable value.
const ref = (r: unknown): string => `${r as string}`;

interface RunMutationCall {
	ref: string;
	args: unknown;
}
interface SchedulerCall {
	delayMs: number;
	ref: string;
	args: unknown;
}

function makeCtx() {
	const runMutationCalls: RunMutationCall[] = [];
	const schedulerCalls: SchedulerCall[] = [];
	let runMutationImpl: (() => Promise<unknown>) | null = null;

	const ctx = {
		runMutation: vi.fn(async (r: unknown, args: unknown) => {
			runMutationCalls.push({ ref: ref(r), args });
			if (runMutationImpl) return runMutationImpl();
			return undefined;
		}),
		scheduler: {
			runAfter: vi.fn(async (delayMs: number, r: unknown, args: unknown) => {
				schedulerCalls.push({ delayMs, ref: ref(r), args });
				return undefined;
			}),
		},
	} as unknown as ActionCtx;

	return {
		ctx,
		runMutationCalls,
		schedulerCalls,
		failNextRunMutation(err: Error) {
			runMutationImpl = () => Promise.reject(err);
		},
		nextRunMutationReturns(value: unknown) {
			runMutationImpl = () => Promise.resolve(value);
		},
	};
}

// Suppress the dispatcher's unconditional console diagnostics for the
// internal.* event kinds so test output stays clean.
beforeEach(() => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('dispatchInboundEvent — Send-lifecycle email events', () => {
	const SEND_LIFECYCLE = ref(internal.delivery.sendLifecycle.transitionByProviderMessageId);

	it('routes email.sent to sendLifecycle with a "sent" transition', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.sent',
			providerMessageId: 'msg-123',
			at: 1000,
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(SEND_LIFECYCLE);
		expect(runMutationCalls[0]?.args).toEqual({
			providerMessageId: 'msg-123',
			transition: {
				to: 'sent',
				at: 1000,
				providerMessageId: 'msg-123',
			},
		});
	});

	it('preserves the optional providerType on email.sent', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.sent',
			providerMessageId: 'msg-123',
			at: 1000,
			providerType: 'resend',
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls[0]?.args).toMatchObject({
			transition: { providerType: 'resend' },
		});
	});

	it('records Gmail accepted volume only after an attributable delivered transition', async () => {
		const { ctx, runMutationCalls, nextRunMutationReturns } = makeCtx();
		nextRunMutationReturns({ ok: true, applied: 'transitioned' });
		const event: InboundEvent = {
			kind: 'email.delivered',
			providerMessageId: 'send_123',
			at: 1000,
			destinationProvider: 'gmail',
			primarySendingDomain: 'example.com',
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(2);
		expect(runMutationCalls[1]).toEqual({
			ref: ref(internal.delivery.complianceTelemetry.recordGmailDelivery),
			args: {
				providerMessageId: 'send_123',
				primaryDomain: 'example.com',
				acceptedAt: 1000,
			},
		});
	});

	it('does not recreate Gmail telemetry for an unknown or terminal Send', async () => {
		const { ctx, runMutationCalls, nextRunMutationReturns } = makeCtx();
		nextRunMutationReturns({ ok: false, reason: 'send_not_found' });

		await dispatchInboundEvent(ctx, {
			kind: 'email.delivered',
			providerMessageId: 'deleted-send',
			at: 1000,
			destinationProvider: 'gmail',
			primarySendingDomain: 'example.com',
		});

		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(SEND_LIFECYCLE);
	});

	it('routes email.delivered to sendLifecycle with a "delivered" transition', async () => {
		const { ctx, runMutationCalls, nextRunMutationReturns } = makeCtx();
		nextRunMutationReturns({ ok: true, applied: 'transitioned' });
		const event: InboundEvent = {
			kind: 'email.delivered',
			providerMessageId: 'msg-abc',
			at: 2000,
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(SEND_LIFECYCLE);
		expect(runMutationCalls[0]?.args).toEqual({
			providerMessageId: 'msg-abc',
			transition: { to: 'delivered', at: 2000 },
		});
	});

	it('routes email.bounced to sendLifecycle carrying bounceType', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.bounced',
			providerMessageId: 'msg-bounce',
			at: 3000,
			bounceType: 'hard',
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(SEND_LIFECYCLE);
		expect(runMutationCalls[0]?.args).toEqual({
			providerMessageId: 'msg-bounce',
			transition: { to: 'bounced', at: 3000, bounceType: 'hard' },
		});
	});

	it('preserves the optional bounceMessage on email.bounced', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.bounced',
			providerMessageId: 'msg-bounce',
			at: 3000,
			bounceType: 'soft',
			bounceMessage: 'mailbox full',
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls[0]?.args).toEqual({
			providerMessageId: 'msg-bounce',
			transition: {
				to: 'bounced',
				at: 3000,
				bounceType: 'soft',
				bounceMessage: 'mailbox full',
			},
		});
	});

	it('routes email.failed to sendLifecycle with a terminal "failed" transition (never "bounced")', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.failed',
			providerMessageId: 'msg-amb',
			at: 3500,
			errorMessage: 'Ambiguous post-DATA drop: connection reset',
			errorCode: 'ambiguous_post_data',
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(SEND_LIFECYCLE);
		expect(runMutationCalls[0]?.args).toEqual({
			providerMessageId: 'msg-amb',
			transition: {
				to: 'failed',
				at: 3500,
				errorMessage: 'Ambiguous post-DATA drop: connection reset',
				errorCode: 'ambiguous_post_data',
			},
		});
		// A terminal failure must NOT be routed as a bounce.
		const transition = (runMutationCalls[0]!.args as { transition: { to: string } }).transition;
		expect(transition.to).not.toBe('bounced');
	});

	it('email.failed never suppresses the recipient (no blockedEmails.addFromEvent)', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.failed',
			providerMessageId: 'msg-amb',
			at: 3500,
			errorMessage: 'reset',
			errorCode: 'ambiguous_post_data',
		};

		await dispatchInboundEvent(ctx, event);

		// The only downstream call is the send-lifecycle transition — never the
		// blocklist mutation a bounce/complaint would trigger.
		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(SEND_LIFECYCLE);
		expect(runMutationCalls.some((c) => c.ref === ref(internal.blockedEmails.addFromEvent))).toBe(
			false
		);
	});

	it('routes email.complained to sendLifecycle with a "complained" transition', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.complained',
			providerMessageId: 'msg-spam',
			at: 4000,
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(SEND_LIFECYCLE);
		expect(runMutationCalls[0]?.args).toEqual({
			providerMessageId: 'msg-spam',
			transition: { to: 'complained', at: 4000 },
		});
	});

	// PR-13: a complaint with no recoverable Message-ID (Gmail FBL redaction)
	// still carries the recipient (RFC 5965 §3.2). The dispatcher suppresses by
	// email directly — never routing through the send lifecycle (no send to
	// transition) and never dropping the complaint.
	it('routes a recipient-only email.complained to blockedEmails.addFromEvent', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.complained',
			recipient: 'victim@example.com',
			at: 4000,
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(ref(internal.blockedEmails.addFromEvent));
		expect(runMutationCalls[0]?.ref).not.toBe(SEND_LIFECYCLE);
		expect(runMutationCalls[0]?.args).toEqual({
			email: 'victim@example.com',
			reason: 'complained',
		});
	});

	it('no-ops an email.complained that carries neither a Message-ID nor a recipient', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event = { kind: 'email.complained', at: 4000 } as InboundEvent;

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(0);
	});

	it('routes email.opened to sendLifecycle with an "opened" transition', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.opened',
			providerMessageId: 'msg-open',
			at: 5000,
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls[0]?.ref).toBe(SEND_LIFECYCLE);
		expect(runMutationCalls[0]?.args).toEqual({
			providerMessageId: 'msg-open',
			transition: { to: 'opened', at: 5000 },
		});
	});

	it('routes email.clicked to sendLifecycle carrying the clicked url', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.clicked',
			providerMessageId: 'msg-click',
			at: 6000,
			url: 'https://example.com/landing',
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls[0]?.ref).toBe(SEND_LIFECYCLE);
		expect(runMutationCalls[0]?.args).toEqual({
			providerMessageId: 'msg-click',
			transition: {
				to: 'clicked',
				at: 6000,
				url: 'https://example.com/landing',
			},
		});
	});
});

describe('dispatchInboundEvent — Postbox message-id routing (pb- prefix)', () => {
	const POSTBOX = ref(internal.mail.postboxOutboundLifecycle.transitionByMtaMessageId);
	const SEND_LIFECYCLE = ref(internal.delivery.sendLifecycle.transitionByProviderMessageId);

	it('routes a pb- prefixed email.sent to the postbox lifecycle, not sendLifecycle', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.sent',
			providerMessageId: 'pb-deadbeef',
			at: 1000,
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(POSTBOX);
		expect(runMutationCalls[0]?.ref).not.toBe(SEND_LIFECYCLE);
		expect(runMutationCalls[0]?.args).toEqual({
			rawProviderMessageId: 'pb-deadbeef',
			input: { to: 'sent', at: 1000 },
		});
	});

	it('routes a pb- prefixed email.bounced to the postbox lifecycle and drops bounceType', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.bounced',
			providerMessageId: 'pb-cafe',
			at: 3000,
			bounceType: 'hard',
			bounceMessage: 'no such user',
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(POSTBOX);
		const args = runMutationCalls[0]?.args as {
			rawProviderMessageId: string;
			input: Record<string, unknown>;
		};
		expect(args.rawProviderMessageId).toBe('pb-cafe');
		expect(args.input).toEqual({
			to: 'bounced',
			at: 3000,
			bounceMessage: 'no such user',
		});
		// Postbox per-recipient bounces discard the hard/soft classification.
		expect(args.input).not.toHaveProperty('bounceType');
	});

	it('routes a pb- prefixed email.failed to the postbox lifecycle with a "failed" transition', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.failed',
			providerMessageId: 'pb-amb',
			at: 3600,
			errorMessage: 'Ambiguous post-DATA drop: connection reset',
			errorCode: 'ambiguous_post_data',
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(POSTBOX);
		expect(runMutationCalls[0]?.ref).not.toBe(SEND_LIFECYCLE);
		expect(runMutationCalls[0]?.args).toEqual({
			rawProviderMessageId: 'pb-amb',
			input: {
				to: 'failed',
				at: 3600,
				errorMessage: 'Ambiguous post-DATA drop: connection reset',
				errorCode: 'ambiguous_post_data',
			},
		});
	});

	it('omits bounceMessage on a pb- bounce when absent', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.bounced',
			providerMessageId: 'pb-cafe',
			at: 3000,
			bounceType: 'soft',
		};

		await dispatchInboundEvent(ctx, event);

		const args = runMutationCalls[0]?.args as {
			input: Record<string, unknown>;
		};
		expect(args.input).toEqual({ to: 'bounced', at: 3000 });
		expect(args.input).not.toHaveProperty('bounceMessage');
	});

	it('maps a pb- prefixed remote delivery confirmation to postbox sent', async () => {
		const { ctx, runMutationCalls, nextRunMutationReturns } = makeCtx();
		nextRunMutationReturns({ ok: true, applied: 'transitioned' });
		const event: InboundEvent = {
			kind: 'email.delivered',
			providerMessageId: 'pb-xyz',
			at: 2000,
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toEqual([
			{
				ref: ref(internal.mail.postboxOutboundLifecycle.observeRemoteAcceptanceByMtaMessageId),
				args: {
					rawProviderMessageId: 'pb-xyz',
					acceptedAt: 2000,
				},
			},
		]);
	});

	it('no-ops a pb- prefixed email.complained', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.complained',
			providerMessageId: 'pb-xyz',
			at: 4000,
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(0);
	});

	it('treats an id that merely contains "pb-" mid-string as a normal Send', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'email.sent',
			providerMessageId: 'msg-pb-123', // prefix check is startsWith only
			at: 1000,
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls[0]?.ref).toBe(SEND_LIFECYCLE);
		expect(runMutationCalls[0]?.ref).not.toBe(POSTBOX);
	});
});

describe('dispatchInboundEvent — inbound + channel ingestion', () => {
	it('routes inbound.received to inbox.messages.receiveMessage with serialized headers', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'inbound.received',
			mail: {
				from: 'sender@example.com',
				to: 'inbox@owlat.test',
				subject: 'Hello',
				textBody: 'plain',
				htmlBody: '<p>html</p>',
				headers: { 'x-custom': 'v' },
				messageId: '<abc@example.com>',
				inReplyTo: '<parent@example.com>',
				references: ['<root@example.com>'],
				attachments: [],
				timestamp: 7000,
			} as InboundEvent extends { kind: 'inbound.received'; mail: infer M } ? M : never,
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(ref(internal.inbox.messages.receiveMessage));
		const args = runMutationCalls[0]?.args as Record<string, unknown>;
		expect(args['from']).toBe('sender@example.com');
		expect(args['headers']).toBe(JSON.stringify({ 'x-custom': 'v' }));
		// Empty attachments => attachmentMeta omitted (undefined).
		expect(args['attachmentMeta']).toBeUndefined();
	});

	it('serializes attachmentMeta only when attachments are present', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const attachments = [{ filename: 'a.pdf', contentType: 'application/pdf' }];
		const event = {
			kind: 'inbound.received',
			mail: {
				from: 'sender@example.com',
				to: 'inbox@owlat.test',
				subject: 'Hello',
				textBody: 'plain',
				htmlBody: '<p>html</p>',
				headers: {},
				messageId: '<abc@example.com>',
				inReplyTo: undefined,
				references: [],
				attachments,
				timestamp: 7000,
			},
		} as unknown as InboundEvent;

		await dispatchInboundEvent(ctx, event);

		const args = runMutationCalls[0]?.args as Record<string, unknown>;
		expect(args['attachmentMeta']).toBe(JSON.stringify(attachments));
	});

	it('routes channel.received to webhooks.channels.processInboundChannel with serialized content', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'channel.received',
			channel: 'sms',
			from: '+15551234567',
			content: { text: 'hi there' },
			externalMessageId: 'ext-1',
			metadata: { region: 'us' },
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(ref(internal.webhooks.channels.processInboundChannel));
		expect(runMutationCalls[0]?.args).toEqual({
			channel: 'sms',
			from: '+15551234567',
			content: JSON.stringify({ text: 'hi there' }),
			externalMessageId: 'ext-1',
			metadata: JSON.stringify({ region: 'us' }),
		});
	});

	it('omits metadata on channel.received when absent', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'channel.received',
			channel: 'whatsapp',
			from: '+15551234567',
			content: { text: 'hi' },
		};

		await dispatchInboundEvent(ctx, event);

		const args = runMutationCalls[0]?.args as Record<string, unknown>;
		expect(args['metadata']).toBeUndefined();
		expect(args['externalMessageId']).toBeUndefined();
	});
});

describe('dispatchInboundEvent — internal signals', () => {
	it('routes circuit_breaker_tripped to abuseStatus.transition with a "warned" transition', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'internal.circuit_breaker_tripped',
			message: 'bounce spike',
			bounceRate: 12,
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(ref(internal.workspaces.abuseStatus.transition));
		const args = runMutationCalls[0]?.args as {
			input: { to: string; reason: string; changedBy: string };
		};
		expect(args.input.to).toBe('warned');
		expect(args.input.changedBy).toBe('mta_circuit_breaker');
		expect(args.input.reason).toContain('bounce spike');
		expect(args.input.reason).toContain('12%');
	});

	it('swallows downstream failures on circuit_breaker_tripped (does not throw)', async () => {
		const { ctx, failNextRunMutation } = makeCtx();
		failNextRunMutation(new Error('abuse mutation failed'));
		const event: InboundEvent = {
			kind: 'internal.circuit_breaker_tripped',
			message: 'bounce spike',
		};

		await expect(dispatchInboundEvent(ctx, event)).resolves.toBeUndefined();
	});

	it('routes campaign_complaint_rate to abuseStatus.transition with a "warned" transition', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'internal.campaign_complaint_rate',
			message: 'Campaign complaint rate 0.40% exceeded 0.3% threshold (4/1000)',
			campaignId: 'jh71d9k2m3n4p5q6r7s8t9v0w1x2y3z4',
			complaintRate: 0.004,
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(ref(internal.workspaces.abuseStatus.transition));
		const args = runMutationCalls[0]?.args as {
			input: { to: string; reason: string; changedBy: string };
		};
		expect(args.input.to).toBe('warned');
		expect(args.input.changedBy).toBe('mta_campaign_complaint_rate');
		// Carries the MTA message + the formatted rate parenthetical + campaign id.
		expect(args.input.reason).toContain('exceeded 0.3% threshold');
		expect(args.input.reason).toContain('(0.40%)');
		expect(args.input.reason).toContain('[campaign jh71d9k2m3n4p5q6r7s8t9v0w1x2y3z4]');
	});

	it('swallows downstream failures on campaign_complaint_rate (does not throw)', async () => {
		const { ctx, failNextRunMutation } = makeCtx();
		failNextRunMutation(new Error('abuse mutation failed'));
		const event: InboundEvent = {
			kind: 'internal.campaign_complaint_rate',
			message: 'rate exceeded',
		};

		await expect(dispatchInboundEvent(ctx, event)).resolves.toBeUndefined();
	});

	it('schedules a warming sync for ip_event subkind=blocklisted', async () => {
		const { ctx, schedulerCalls, runMutationCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'internal.ip_event',
			subkind: 'blocklisted',
			ip: '203.0.113.5',
			severity: 'critical',
			message: 'listed on a DNSBL',
		};

		await dispatchInboundEvent(ctx, event);

		expect(runMutationCalls).toHaveLength(0);
		expect(schedulerCalls).toHaveLength(1);
		expect(schedulerCalls[0]?.delayMs).toBe(0);
		expect(schedulerCalls[0]?.ref).toBe(ref(internal.delivery.warmingSync.syncWarmingState));
	});

	it('schedules a warming sync for ip_event subkind=warming_complete', async () => {
		const { ctx, schedulerCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'internal.ip_event',
			subkind: 'warming_complete',
		};

		await dispatchInboundEvent(ctx, event);

		expect(schedulerCalls).toHaveLength(1);
		expect(schedulerCalls[0]?.ref).toBe(ref(internal.delivery.warmingSync.syncWarmingState));
	});

	it('does NOT schedule a warming sync for ip_event subkind=all_blocked', async () => {
		const { ctx, schedulerCalls } = makeCtx();
		const event: InboundEvent = {
			kind: 'internal.ip_event',
			subkind: 'all_blocked',
		};

		await dispatchInboundEvent(ctx, event);

		expect(schedulerCalls).toHaveLength(0);
	});
});

describe('dispatchInboundEvent — unresolved-bounce observability', () => {
	const SEND_NOT_FOUND = { ok: false, reason: 'send_not_found' } as const;

	// The global beforeEach already spies console.warn (which logWarn forwards to)
	// with a no-op; grab that spy to assert on the emitted message.
	function warnSpy() {
		return console.warn as unknown as ReturnType<typeof vi.fn>;
	}
	function warnMessages(): string[] {
		return warnSpy().mock.calls.map((c) => String(c[0]));
	}

	// The file-level beforeEach re-spies console.warn but does not reset its
	// recorded calls; clear them so each assertion sees only this test's output.
	beforeEach(() => {
		warnSpy().mockClear();
	});

	it('logs an unresolved_bounce signal when email.bounced resolves to no Send row', async () => {
		const { ctx, runMutationCalls, nextRunMutationReturns } = makeCtx();
		// transitionByProviderMessageId resolves the id to no row.
		nextRunMutationReturns(SEND_NOT_FOUND);
		const event: InboundEvent = {
			kind: 'email.bounced',
			providerMessageId: 'msg-orphan',
			at: 3000,
			bounceType: 'hard',
		};

		await dispatchInboundEvent(ctx, event);

		// The transition was still attempted (we don't drop the event)…
		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]?.ref).toBe(
			ref(internal.delivery.sendLifecycle.transitionByProviderMessageId)
		);
		// …but the no-row outcome now emits an observable signal rather than a no-op.
		const messages = warnMessages();
		expect(messages.some((m) => m.includes('unresolved_bounce'))).toBe(true);
		expect(messages.some((m) => m.includes('email.bounced'))).toBe(true);
		expect(messages.some((m) => m.includes('msg-orphan'))).toBe(true);
	});

	it('logs an unresolved_bounce signal when email.complained resolves to no Send row', async () => {
		const { ctx, nextRunMutationReturns } = makeCtx();
		nextRunMutationReturns(SEND_NOT_FOUND);
		const event: InboundEvent = {
			kind: 'email.complained',
			providerMessageId: 'msg-ghost',
			at: 4000,
		};

		await dispatchInboundEvent(ctx, event);

		const messages = warnMessages();
		expect(messages.some((m) => m.includes('unresolved_bounce'))).toBe(true);
		expect(messages.some((m) => m.includes('email.complained'))).toBe(true);
		expect(messages.some((m) => m.includes('msg-ghost'))).toBe(true);
	});

	it('does NOT emit an unresolved_bounce signal when the Send row is found', async () => {
		const { ctx, nextRunMutationReturns } = makeCtx();
		nextRunMutationReturns({
			ok: true,
			applied: 'transitioned',
			from: 'sent',
			to: 'bounced',
			contactEmail: 'c@x.com',
		});
		const event: InboundEvent = {
			kind: 'email.bounced',
			providerMessageId: 'msg-known',
			at: 3000,
			bounceType: 'hard',
		};

		await dispatchInboundEvent(ctx, event);

		expect(warnMessages().some((m) => m.includes('unresolved_bounce'))).toBe(false);
	});

	it('does NOT emit an unresolved_bounce signal for a non-negative event (email.delivered)', async () => {
		const { ctx, nextRunMutationReturns } = makeCtx();
		// Even if a delivered event resolves to no row, that path stays quiet —
		// only bounce/complaint are negative feedback we must not lose.
		nextRunMutationReturns(SEND_NOT_FOUND);
		const event: InboundEvent = {
			kind: 'email.delivered',
			providerMessageId: 'msg-orphan',
			at: 2000,
		};

		await dispatchInboundEvent(ctx, event);

		expect(warnMessages().some((m) => m.includes('unresolved_bounce'))).toBe(false);
	});
});

describe('dispatchInboundEvent — DKIM rotation propagation', () => {
	const RECORD_DKIM_ROTATION = ref(internal.domains.lifecycle.recordDkimRotation);

	it.each(['pending', 'activated'] as const)(
		'routes internal.dkim_rotated (phase=%s) to recordDkimRotation',
		async (phase) => {
			const { ctx, runMutationCalls } = makeCtx();
			const event: InboundEvent = {
				kind: 'internal.dkim_rotated',
				domain: 'rotate.com',
				selector: 's2',
				dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
				phase,
			};

			await dispatchInboundEvent(ctx, event);

			expect(runMutationCalls).toHaveLength(1);
			expect(runMutationCalls[0]?.ref).toBe(RECORD_DKIM_ROTATION);
			expect(runMutationCalls[0]?.args).toEqual({
				domain: 'rotate.com',
				selector: 's2',
				dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
				phase,
				userId: 'system:dkim_rotation',
			});
		}
	);
});

describe('dispatchInboundEvent — unknown event kinds', () => {
	it('rejects an unknown event kind (no handler in the dispatch table)', async () => {
		const { ctx } = makeCtx();
		const event = {
			kind: 'email.exploded',
			providerMessageId: 'x',
			at: 1,
		} as unknown as InboundEvent;

		// No handler => `handler` is undefined => calling it throws a TypeError.
		await expect(dispatchInboundEvent(ctx, event)).rejects.toThrow(TypeError);
	});

	it('does not dispatch any mutation for an unknown event kind', async () => {
		const { ctx, runMutationCalls, schedulerCalls } = makeCtx();
		const event = { kind: 'totally.bogus' } as unknown as InboundEvent;

		await dispatchInboundEvent(ctx, event).catch(() => {});

		expect(runMutationCalls).toHaveLength(0);
		expect(schedulerCalls).toHaveLength(0);
	});
});
