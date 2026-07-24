import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';
import { mtaAdapter } from '../webhooks/adapters/mta';

const enqueueAction = vi.fn().mockResolvedValue('work-1');
vi.mock('../delivery/workpool', () => ({
	campaignEmailPool: { enqueueAction },
	transactionalEmailPool: { enqueueAction },
}));

const modules = import.meta.glob('../**/*.*s');

beforeEach(() => {
	enqueueAction.mockClear();
	vi.stubEnv('INSTANCE_SECRET', 'routing-reentry-test-secret-at-least-32-characters');
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

async function fixture(attempt = 2) {
	const t = convexTest(schema, modules);
	const sendId = await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		const contactId = await ctx.db.insert('contacts', createTestContact());
		return ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				status: 'queued',
				providerMessageId: undefined,
			})
		);
	});
	const envelopeInput = {
		kind: 'campaign' as const,
		to: 'person@example.com',
		from: 'sender@example.org',
		template: { subject: 'Hello', htmlContent: '<p>Hello</p>' },
		contactInfo: { email: 'person@example.com' },
		emailSendId: sendId,
		organizationId: 'org-1',
	};
	const retryState = {
		attempt,
		startedAt: Date.now(),
		idempotencyKey: `send_${sendId}`,
	};
	const issued = await t.mutation(internal.delivery.routingReentry.issueSnapshot, {
		sendRef: { kind: 'campaign', id: sendId },
		organizationId: 'org-1',
		messageId: retryState.idempotencyKey,
		workAttemptId: 'work-attempt-1',
		envelopeInput,
		retryState,
	});
	return { t, sendId, envelopeInput, retryState, token: issued.token };
}

function callbackArgs(value: Awaited<ReturnType<typeof fixture>>) {
	return {
		token: value.token,
		messageId: value.retryState.idempotencyKey,
		workAttemptId: 'work-attempt-1',
		reason: 'circuit_breaker_changed' as const,
		envelopeInput: value.envelopeInput,
		retryState: value.retryState,
	};
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(',')}}`;
}

async function legacyToken(
	value: Awaited<ReturnType<typeof fixture>>,
	secret: string
): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(
				canonicalJson({ envelopeInput: value.envelopeInput, retryState: value.retryState })
			)
		)
	);
	const digestBase64 = btoa(String.fromCharCode(...digest))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '');
	const payload = {
		v: 1,
		k: 'c',
		i: value.sendId,
		o: 'org-1',
		m: value.retryState.idempotencyKey,
		w: 'work-attempt-1',
		a: value.retryState.attempt,
		e: value.retryState.startedAt + GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
		d: digestBase64,
	};
	const keyBytes = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`owlat-routing-reentry-key-v1\0${secret}`)
	);
	const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
	const iv = new Uint8Array(12).fill(7);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{
				name: 'AES-GCM',
				iv,
				additionalData: new TextEncoder().encode('owlat-routing-reentry:v1'),
			},
			key,
			new TextEncoder().encode(JSON.stringify(payload))
		)
	);
	const combined = new Uint8Array(iv.length + ciphertext.length);
	combined.set(iv);
	combined.set(ciphertext, iv.length);
	return `rr1.${btoa(String.fromCharCode(...combined))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '')}`;
}

describe('authenticated MTA routing re-entry', () => {
	async function originalMtaCompletion(value: Awaited<ReturnType<typeof fixture>>) {
		await value.t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: 'original-mta-work' as never,
			result: {
				kind: 'success',
				returnValue: {
					success: true,
					providerMessageId: value.retryState.idempotencyKey,
					providerType: 'mta',
					acceptedForDelivery: true,
				},
			},
			context: { sendRef: { kind: 'campaign', id: value.sendId } },
		});
	}

	async function establishRelayReentry(order: 'completion-first' | 'callback-first') {
		const value = await fixture();
		if (order === 'completion-first') await originalMtaCompletion(value);
		expect(
			await value.t.mutation(internal.delivery.routingReentry.consumeSnapshot, callbackArgs(value))
		).toMatchObject({ disposition: 'enqueued' });
		if (order === 'callback-first') await originalMtaCompletion(value);
		expect((await value.t.run((ctx) => ctx.db.get(value.sendId)))?.status).toBe('queued');
		return value;
	}

	it.each(['completion-first', 'callback-first'] as const)(
		'terminates a relay success and resolves later webhooks by relay id (%s)',
		async (order) => {
			const value = await establishRelayReentry(order);
			const relayId = `ses-relay-${order}`;
			await value.t.mutation(internal.delivery.sendCompletion.completeSend, {
				workId: 'relay-work' as never,
				result: {
					kind: 'success',
					returnValue: {
						success: true,
						providerMessageId: relayId,
						providerType: 'ses',
					},
				},
				context: { sendRef: { kind: 'campaign', id: value.sendId } },
			});
			expect(await value.t.run((ctx) => ctx.db.get(value.sendId))).toMatchObject({
				status: 'sent',
				providerMessageId: relayId,
				providerType: 'ses',
			});
			const lookup = await value.t.mutation(
				internal.delivery.sendLifecycle.transitionByProviderMessageId,
				{
					providerMessageId: relayId,
					transition: {
						to: 'sent',
						at: Date.now(),
						providerMessageId: relayId,
						providerType: 'ses',
					},
				}
			);
			expect(lookup).toMatchObject({ ok: true, applied: 'duplicate' });
		}
	);

	it.each(['completion-first', 'callback-first'] as const)(
		'terminates a relay failure without allowing the late MTA acceptance to mark sent (%s)',
		async (order) => {
			const value = await establishRelayReentry(order);
			await value.t.mutation(internal.delivery.sendCompletion.completeSend, {
				workId: 'relay-work' as never,
				result: { kind: 'failed', error: 'SES relay rejected the request' },
				context: { sendRef: { kind: 'campaign', id: value.sendId } },
			});
			expect(await value.t.run((ctx) => ctx.db.get(value.sendId))).toMatchObject({
				status: 'failed',
				errorCode: 'WORKPOOL_FAILED',
				errorMessage: 'SES relay rejected the request',
			});
		}
	);

	it('atomically accepts a newer attempt and rejects the duplicate callback', async () => {
		const value = await fixture();
		const first = await value.t.mutation(
			internal.delivery.routingReentry.consumeSnapshot,
			callbackArgs(value)
		);
		const duplicate = await value.t.mutation(
			internal.delivery.routingReentry.consumeSnapshot,
			callbackArgs(value)
		);

		expect(first).toMatchObject({ disposition: 'enqueued' });
		expect(duplicate).toEqual({ disposition: 'duplicate' });
		expect(enqueueAction).toHaveBeenCalledOnce();
		expect(await value.t.run((ctx) => ctx.db.get(value.sendId))).toMatchObject({
			status: 'queued',
			providerMessageId: value.retryState.idempotencyKey,
			mtaRoutingReentryAttempt: 2,
		});
	});

	it('accepts an rr1 token under the rolling previous secret during deployment', async () => {
		const value = await fixture();
		const previousSecret = 'previous-routing-reentry-secret-at-least-32-characters';
		const token = await legacyToken(value, previousSecret);
		vi.stubEnv('INSTANCE_SECRET', 'current-routing-reentry-secret-at-least-32-characters');
		vi.stubEnv('INSTANCE_SECRET_PREVIOUS', previousSecret);

		expect(
			await value.t.mutation(internal.delivery.routingReentry.consumeSnapshot, {
				...callbackArgs(value),
				token,
			})
		).toMatchObject({ disposition: 'enqueued' });
		expect(enqueueAction).toHaveBeenCalledOnce();
	});

	it('fails closed when the authenticated token is tampered', async () => {
		const value = await fixture();
		const args = callbackArgs(value);
		const result = await value.t.mutation(internal.delivery.routingReentry.consumeSnapshot, {
			...args,
			token: `${args.token.slice(0, -1)}${args.token.endsWith('A') ? 'B' : 'A'}`,
		});
		expect(result).toEqual({ disposition: 'invalid_token' });
		expect(enqueueAction).not.toHaveBeenCalled();
	});

	it('rejects callback material rebound to another organization', async () => {
		const value = await fixture();
		const result = await value.t.mutation(internal.delivery.routingReentry.consumeSnapshot, {
			...callbackArgs(value),
			envelopeInput: { ...value.envelopeInput, organizationId: 'org-2' },
		});
		expect(result).toEqual({ disposition: 'binding_mismatch' });
		expect(enqueueAction).not.toHaveBeenCalled();
	});

	it('rejects the exact token at the cumulative deadline boundary', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const value = await fixture();
		vi.advanceTimersByTime(GOVERNED_MTA_MAX_MESSAGE_AGE_MS);
		const result = await value.t.mutation(
			internal.delivery.routingReentry.consumeSnapshot,
			callbackArgs(value)
		);
		expect(result).toEqual({ disposition: 'deadline_expired' });
		expect(enqueueAction).not.toHaveBeenCalled();
		expect(await value.t.run((ctx) => ctx.db.get(value.sendId))).toMatchObject({
			status: 'failed',
			errorCode: 'DELIVERY_DEADLINE_EXPIRED',
		});
	});

	it.each([
		{ offset: GOVERNED_MTA_MAX_MESSAGE_AGE_MS - 1, disposition: 'enqueued' },
		{ offset: GOVERNED_MTA_MAX_MESSAGE_AGE_MS, disposition: 'deadline_expired' },
		{ offset: GOVERNED_MTA_MAX_MESSAGE_AGE_MS + 1, disposition: 'deadline_expired' },
	] as const)(
		'handles delayed DLQ recovery at cumulative offset $offset without resetting its origin',
		async ({ offset, disposition }) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
			const value = await fixture();
			vi.advanceTimersByTime(offset);

			const result = await value.t.mutation(
				internal.delivery.routingReentry.consumeSnapshot,
				callbackArgs(value)
			);
			expect(result).toMatchObject({ disposition });
			if (disposition === 'enqueued') {
				expect(enqueueAction).toHaveBeenCalledOnce();
				expect(enqueueAction.mock.calls[0]?.[2]).toMatchObject({
					retryState: { startedAt: value.retryState.startedAt },
				});
				expect(await value.t.run((ctx) => ctx.db.get(value.sendId))).toMatchObject({
					status: 'queued',
					mtaRoutingReentryAttempt: 2,
				});
			} else {
				expect(enqueueAction).not.toHaveBeenCalled();
				expect(await value.t.run((ctx) => ctx.db.get(value.sendId))).toMatchObject({
					status: 'failed',
					errorCode: 'DELIVERY_DEADLINE_EXPIRED',
				});
			}
		}
	);

	it('re-enters through the real webhook wire after an acceptance-unknown reconciliation', async () => {
		// `governedDispatch` adds `workAttemptId` + `acceptanceReconciliation` to
		// the retryState when MTA acceptance is unknown, and the callback digest
		// covers the whole object. This asserts the exact bytes the MTA echoes
		// survive `mtaAdapter.parseEvent` and still match the issued digest —
		// otherwise the Send is stranded `queued` behind a permanent 409.
		const value = await fixture(2);
		const retryState = {
			...value.retryState,
			workAttemptId: 'work-attempt-1',
			acceptanceReconciliation: true,
		};
		const issued = await value.t.mutation(internal.delivery.routingReentry.issueSnapshot, {
			sendRef: { kind: 'campaign', id: value.sendId },
			organizationId: 'org-1',
			messageId: retryState.idempotencyKey,
			workAttemptId: 'work-attempt-1',
			envelopeInput: value.envelopeInput,
			retryState,
		});

		const parsed = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'routing.reentry',
				messageId: retryState.idempotencyKey,
				routingReentryToken: issued.token,
				workAttemptId: 'work-attempt-1',
				routingReentryReason: 'warming_capacity_changed',
				routingReentry: { envelopeInput: value.envelopeInput, retryState },
				timestamp: Date.now(),
			})
		);
		expect(parsed).not.toBeNull();
		const event = parsed as Extract<
			NonNullable<typeof parsed>,
			{ kind: 'internal.routing_reentry' }
		>;

		expect(
			await value.t.mutation(internal.delivery.routingReentry.consumeSnapshot, {
				token: event.token,
				messageId: event.providerMessageId,
				workAttemptId: event.workAttemptId,
				reason: event.reason,
				envelopeInput: event.envelopeInput,
				retryState: event.retryState,
			})
		).toMatchObject({ disposition: 'enqueued' });
		expect(enqueueAction).toHaveBeenCalledOnce();
	});

	it('marks the Send failed instead of creating attempt nine', async () => {
		const value = await fixture(9);
		const result = await value.t.mutation(
			internal.delivery.routingReentry.consumeSnapshot,
			callbackArgs(value)
		);
		expect(result).toEqual({ disposition: 'retry_exhausted' });
		expect(enqueueAction).not.toHaveBeenCalled();
		expect(await value.t.run((ctx) => ctx.db.get(value.sendId))).toMatchObject({
			status: 'failed',
			errorCode: 'ROUTING_RETRY_EXHAUSTED',
			mtaRoutingReentryAttempt: 9,
		});
	});
});
