/**
 * Sending stopping and resuming travels the deliverability alert channels:
 * one `deliverability.alert_raised` / `deliverability.alert_resolved` per
 * transition to every subscribed webhook, and the alert email to the owners
 * and admins. Only the network edges are stubbed: the system-mail transport
 * and the webhook endpoint's HTTP answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	deliverabilityAlertRaisedWebhookSchema,
	deliverabilityAlertResolvedWebhookSchema,
	sendingHoldLiftSchema,
} from '@owlat/public-contract/schemas';
import { components, internal } from '../_generated/api';
import { readStandingSendingHold } from '../delivery/sendingHoldAlerts';
import { _resetSingletonOrgCacheForTests } from '../lib/sessionOrganization';
import type * as SsrfGuard from '../lib/ssrfGuard';
import { fetchWithGuardedDispatcher } from '../lib/ssrfGuard';
import { newBetterAuthHarness } from './testModules';

type SentMail = { to: string; subject: string; html: string; idempotencyKey?: string };

const transport = vi.hoisted(() => ({
	sent: [] as SentMail[],
	isFailing: false,
}));

// The system-mail transport, the one network edge of the alert email.
vi.mock('../maintenance/systemMail', async () => {
	const { internalAction } = await import('../_generated/server');
	const { v } = await import('convex/values');
	const args = {
		to: v.string(),
		from: v.string(),
		subject: v.string(),
		html: v.string(),
		idempotencyKey: v.optional(v.string()),
		replyTo: v.optional(v.string()),
		attachments: v.optional(v.any()),
	};
	const handler = async (_ctx: unknown, mail: SentMail) => {
		if (transport.isFailing) {
			return {
				status: 'failed' as const,
				provider: 'mta' as const,
				errorCode: 'SERVER_ERROR',
				errorMessage: 'connection refused',
				retryDisposition: 'terminal' as const,
			};
		}
		transport.sent.push(mail);
		return {
			status: 'accepted' as const,
			provider: 'mta' as const,
			providerMessageId: `message-${transport.sent.length}`,
			latencyMs: 1,
			attempts: 1,
		};
	};
	return {
		trySendSystemEmail: internalAction({ args, handler }),
		sendSystemEmail: internalAction({ args, handler }),
	};
});

// The webhook endpoint's answer; signing, retries and the delivery log are real.
vi.mock('../lib/ssrfGuard', async (importOriginal) => ({
	...(await importOriginal<typeof SsrfGuard>()),
	validatePublicUrl: vi.fn(async (url: string) => ({ ok: true, url: new URL(url) })),
	fetchWithGuardedDispatcher: vi.fn(async () => new Response('ok', { status: 200 })),
}));

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('files/processing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 12);
const SUSPEND_REASON = 'Auto-suspended: complaint rate or bounce rate exceeded critical thresholds';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.stubEnv('DEFAULT_FROM_DOMAIN', 'mail.example.com');
	vi.stubEnv('EMAIL_PROVIDER', 'mta');
	transport.sent = [];
	transport.isFailing = false;
	vi.mocked(fetchWithGuardedDispatcher).mockImplementation(
		async () => new Response('ok', { status: 200 })
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

/** One organization with an owner, an admin who turned deliverability alerts off, and an editor. */
async function harness(
	settings: Record<string, unknown> = {},
	options: { adminLocale?: 'en' | 'de' } = {}
) {
	_resetSingletonOrgCacheForTests();
	const t = newBetterAuthHarness(modules);
	const org = (await t.mutation(components.betterAuth.adapter.create, {
		input: { model: 'organization', data: { name: 'Acme', slug: 'acme', createdAt: 1 } },
	} as never)) as { _id: string };
	const ids: Record<string, string> = {};
	for (const role of ['owner', 'admin', 'editor'] as const) {
		const user = (await t.mutation(components.betterAuth.adapter.create, {
			input: {
				model: 'user',
				data: {
					name: role,
					email: `${role}@example.com`,
					emailVerified: true,
					createdAt: 1,
					updatedAt: 1,
				},
			},
		} as never)) as { _id: string };
		ids[role] = user._id;
		await t.mutation(components.betterAuth.adapter.create, {
			input: {
				model: 'member',
				data: { organizationId: org._id, userId: user._id, role, createdAt: 1 },
			},
		} as never);
	}
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			contactCount: 0,
			createdAt: NOW - 30 * DAY_MS,
			featureFlags: { webhooks: true },
			...settings,
		});
		await ctx.db.insert('marketingNotificationSettings', {
			userId: ids['admin']!,
			isDeliverabilityAlertsOn: false,
			updatedAt: 1,
		});
		if (options.adminLocale) {
			await ctx.db.insert('userProfiles', {
				authUserId: ids['admin']!,
				email: 'admin@example.com',
				locale: options.adminLocale,
				createdAt: 1,
				updatedAt: 1,
			});
		}
		await ctx.db.insert('webhooks', {
			name: 'On-call',
			url: 'https://oncall.example.com/hook',
			events: ['deliverability.alert_raised', 'deliverability.alert_resolved'],
			secret: 'whsec_test',
			isActive: true,
			createdAt: 1,
			updatedAt: 1,
		});
		// A 30-day window with a 12% bounce rate: over the suspension line.
		await ctx.db.insert('sendingReputation', {
			scope: 'org',
			periodStart: NOW - (NOW % DAY_MS),
			shardKey: 0,
			totalSent: 1000,
			totalDelivered: 880,
			totalBounced: 120,
			totalHardBounced: 120,
			totalComplaints: 0,
			lastCalculatedAt: NOW,
		});
	});
	return t;
}
type Tester = Awaited<ReturnType<typeof harness>>;

async function settle(t: Tester): Promise<void> {
	await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function alertPayloads(t: Tester) {
	const logs = await t.run((ctx) => ctx.db.query('webhookDeliveryLogs').collect());
	return logs.map((log) => ({ status: log.status, payload: log.payload }));
}

function suspend(t: Tester, at = Date.now()) {
	return t.mutation(internal.workspaces.abuseStatus.transition, {
		input: {
			to: 'suspended',
			at,
			reason: SUSPEND_REASON,
			changedBy: 'system',
			trigger: { code: 'bounce_rate' },
		},
	});
}

function resumeByCheck(t: Tester, at = Date.now()) {
	return t.mutation(internal.workspaces.abuseStatus.transition, {
		input: {
			to: 'clean',
			at,
			reason: 'Auto-cleared: bounce rate back under 5%',
			changedBy: 'system',
			trigger: { code: 'bounce_rate' },
		},
	});
}

describe('sending suspended and resumed on the alert channels', () => {
	it('a suspension raises one alert on the webhook and mails every owner and admin', async () => {
		const t = await harness();

		await suspend(t);
		await settle(t);

		const logs = await alertPayloads(t);
		expect(logs).toHaveLength(1);
		const raised = deliverabilityAlertRaisedWebhookSchema.parse(logs[0]!.payload);
		expect(raised.data).toMatchObject({
			checkId: 'deployment.sending_hold',
			check: 'Sending suspended',
			severity: 'blocking',
			scope: 'deployment',
			domain: null,
			message: SUSPEND_REASON,
			holdStatus: 'suspended',
			observedAt: new Date(NOW).toISOString(),
			emailMayNotArrive: true,
			isTest: false,
		});
		expect(raised.data.nextAction).toBe(
			'It lifts by itself once the bounce rate over the last 30 days is under 5%; it is 12% now. Nothing to do unless you want sending back sooner: a platform admin can lift it in the Operator console.'
		);
		// The lift is the status endpoint's object, carried as JSON in the flat payload.
		expect(sendingHoldLiftSchema.parse(JSON.parse(raised.data.lift!))).toEqual({
			mode: 'automatic',
			condition: {
				trigger: 'bounce_rate',
				domain: null,
				currentPct: 12,
				limitPct: 5,
				isClear: false,
				clearsAt: null,
			},
		});

		// The audience of every alert email: owners and admins, with or without
		// the switch, which governs the in-app notice and push. Not the editor.
		expect(transport.sent.map((mail) => mail.to).sort()).toEqual([
			'admin@example.com',
			'owner@example.com',
		]);
		const mail = transport.sent[0]!;
		expect(mail.subject).toBe('Owlat: sending is suspended');
		expect(mail.html).toContain('Sending on your Owlat instance is suspended.');
		expect(mail.html).toContain(SUSPEND_REASON);
		expect(mail.html).toContain(
			'It lifts by itself once the bounce rate over the last 30 days is under 5%'
		);
	});

	it('a resume by the reputation check resolves the alert it raised, automatically', async () => {
		const t = await harness();
		await suspend(t);
		await settle(t);
		const raised = deliverabilityAlertRaisedWebhookSchema.parse(
			(await alertPayloads(t))[0]!.payload
		);
		transport.sent = [];

		vi.setSystemTime(NOW + 3 * DAY_MS);
		await resumeByCheck(t);
		await settle(t);

		const logs = await alertPayloads(t);
		expect(logs).toHaveLength(2);
		const resolved = deliverabilityAlertResolvedWebhookSchema.parse(logs[1]!.payload);
		expect(resolved.data).toEqual({
			alertId: raised.data.alertId,
			checkId: 'deployment.sending_hold',
			check: 'Sending suspended',
			scope: 'deployment',
			domain: null,
			resolvedAt: new Date(NOW + 3 * DAY_MS).toISOString(),
			resolution: 'automatic',
		});
		expect(transport.sent).toHaveLength(2);
		expect(transport.sent[0]!.subject).toBe('Owlat: sending resumed');
		expect(transport.sent[0]!.html).toContain(
			'The reputation check lifted the suspension by itself: Auto-cleared: bounce rate back under 5%'
		);
	});

	it('a platform admin lift under a hold resolves the alert as manual', async () => {
		const t = await harness();
		await suspend(t);
		await settle(t);
		transport.sent = [];

		await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'clean', at: Date.now(), reason: 'list cleaned', changedBy: 'admin-1' },
		});
		await settle(t);

		const logs = await alertPayloads(t);
		expect(logs).toHaveLength(2);
		expect(deliverabilityAlertResolvedWebhookSchema.parse(logs[1]!.payload).data).toMatchObject({
			resolution: 'manual',
		});
		expect(transport.sent[0]!.html).toContain('A platform admin lifted it: list cleaned');
		// The lift held the evidence, so the next hourly check does not suspend again.
		await t.mutation(internal.analytics.reputationCheck.evaluateAutoEnforce, {});
		await settle(t);
		expect(await alertPayloads(t)).toHaveLength(2);
	});

	it('suspend, resume, suspend in quick succession sends exactly three alerts', async () => {
		const t = await harness();

		await suspend(t, NOW);
		await resumeByCheck(t, NOW + 1);
		await suspend(t, NOW + 2);
		await settle(t);

		const payloads = (await alertPayloads(t)).map((log) => log.payload);
		expect(payloads.map((payload) => payload.event)).toEqual([
			'deliverability.alert_raised',
			'deliverability.alert_resolved',
			'deliverability.alert_raised',
		]);
		const [first, resolved, second] = payloads.map((payload) => payload.data['alertId']);
		expect(resolved).toBe(first);
		expect(second).not.toBe(first);
		// Two people each hear about all three.
		expect(transport.sent).toHaveLength(6);
	});

	it('a warning, a same-state recheck and a warning clearing send nothing', async () => {
		const t = await harness();

		await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: {
				to: 'warned',
				at: NOW,
				reason: 'Auto-warned: complaint rate or bounce rate exceeding safe thresholds',
				changedBy: 'system',
				trigger: { code: 'bounce_rate' },
			},
		});
		await resumeByCheck(t, NOW + 1);
		await suspend(t, NOW + 2);
		await settle(t);
		await t.mutation(internal.workspaces.abuseStatus.transition, {
			isRecheck: true,
			input: {
				to: 'suspended',
				at: NOW + 3,
				reason: SUSPEND_REASON,
				changedBy: 'system',
				trigger: { code: 'bounce_rate' },
			},
		});
		await settle(t);

		expect((await alertPayloads(t)).map((log) => log.payload.event)).toEqual([
			'deliverability.alert_raised',
		]);
		expect(transport.sent).toHaveLength(2);
	});

	it('a ban says a platform admin lifts it, and nothing lifts it by itself', async () => {
		const t = await harness();

		await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'banned', at: NOW, reason: 'phishing', changedBy: 'admin-1' },
		});
		await settle(t);

		const logs = await alertPayloads(t);
		expect(logs).toHaveLength(1);
		const raised = deliverabilityAlertRaisedWebhookSchema.parse(logs[0]!.payload);
		expect(raised.data).toMatchObject({
			check: 'Sending banned',
			holdStatus: 'banned',
			message: 'phishing',
			nextAction: 'It does not lift by itself. A platform admin lifts it in the Operator console.',
		});
		expect(JSON.parse(raised.data.lift!)).toEqual({ mode: 'admin', condition: null });
		expect(transport.sent[0]!.subject).toBe('Owlat: sending is banned');

		// The hourly check cannot leave a ban, so no resolve goes out.
		await resumeByCheck(t, NOW + 1);
		await settle(t);
		expect(await alertPayloads(t)).toHaveLength(1);
	});

	it('a suspension turned into a ban raises the alert again, and one resolve closes it', async () => {
		const t = await harness();
		await suspend(t, NOW);
		await settle(t);
		transport.sent = [];
		await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'banned', at: NOW + 1, reason: 'phishing', changedBy: 'admin-1' },
		});
		await settle(t);

		// Everyone told "suspended" is told "banned".
		expect(transport.sent.map((mail) => mail.to).sort()).toEqual([
			'admin@example.com',
			'owner@example.com',
		]);
		expect(transport.sent[0]!.subject).toBe('Owlat: sending is now banned');
		expect(transport.sent[0]!.html).toContain(
			'Sending on your Owlat instance was suspended and is now banned.'
		);
		const notices = await t.run((ctx) => ctx.db.query('marketingNotices').collect());
		expect(notices.map((notice) => notice.holdStatus)).toEqual(['suspended', 'banned']);

		await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'clean', at: NOW + 2, reason: 'appeal granted', changedBy: 'admin-1' },
		});
		await settle(t);

		const payloads = (await alertPayloads(t)).map((log) => log.payload);
		expect(payloads.map((payload) => payload.event)).toEqual([
			'deliverability.alert_raised',
			'deliverability.alert_raised',
			'deliverability.alert_resolved',
		]);
		const banned = deliverabilityAlertRaisedWebhookSchema.parse(payloads[1]!).data;
		expect(banned).toMatchObject({
			alertId: payloads[0]!.data['alertId'],
			check: 'Sending banned',
			holdStatus: 'banned',
			previousHoldStatus: 'suspended',
			message: 'phishing',
		});
		expect(payloads[0]!.data['previousHoldStatus']).toBeUndefined();
		expect(payloads[2]!.data['alertId']).toBe(payloads[0]!.data['alertId']);
		expect(payloads[2]!.data['resolution']).toBe('manual');
	});

	it('a ban turned back into a suspension raises the alert again', async () => {
		const t = await harness();
		await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'banned', at: NOW, reason: 'phishing', changedBy: 'admin-1' },
		});
		await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'suspended', at: NOW + 1, reason: 'under review', changedBy: 'admin-1' },
		});
		await settle(t);

		const payloads = (await alertPayloads(t)).map((log) => log.payload.data);
		expect(payloads.map((data) => [data['holdStatus'], data['previousHoldStatus']])).toEqual([
			['banned', undefined],
			['suspended', 'banned'],
		]);
		// The "banned" email still waiting on a retry is no longer current.
		expect(
			await t.query(internal.delivery.sendingHoldAlerts.isAlertCurrent, {
				alert: {
					kind: 'raised',
					alertId: payloads[0]!['alertId'] as string,
					holdStatus: 'banned',
					reason: 'phishing',
					lift: JSON.stringify({ mode: 'admin', condition: null }),
					nextAction: '',
					at: NOW,
					emailMayNotArrive: true,
				},
			})
		).toBe(false);
	});

	it('a new reason under the same status announces nothing', async () => {
		const t = await harness();
		await suspend(t, NOW);
		await settle(t);
		await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'suspended', at: NOW + 1, reason: 'kept by hand', changedBy: 'admin-1' },
		});
		await settle(t);

		expect(await alertPayloads(t)).toHaveLength(1);
		expect(transport.sent).toHaveLength(2);
	});

	it('records what each channel did with the hold, for the Deliverability Center', async () => {
		const t = await harness();
		await suspend(t, NOW);
		await settle(t);

		const standing = await t.run(async (ctx) =>
			readStandingSendingHold(ctx, await ctx.db.query('instanceSettings').first())
		);
		expect(standing).toEqual({
			alertId: `sending_hold:${NOW}`,
			holdStatus: 'suspended',
			previousHoldStatus: null,
			reason: SUSPEND_REASON,
			observedAt: NOW,
			channels: {
				email: { state: 'sent', isOnAffectedTransport: true },
				// The admin switched deliverability alerts off; the owner has them on.
				inAppCount: 1,
				push: { delivered: 0, failed: 0, held: 0 },
				webhook: { delivered: 1, failed: 0, pending: 0 },
			},
		});

		await resumeByCheck(t, NOW + 1);
		await settle(t);
		const resumed = await t.run(async (ctx) =>
			readStandingSendingHold(ctx, await ctx.db.query('instanceSettings').first())
		);
		expect(resumed).toBeNull();
	});

	it('records an email nobody accepted as not sent', async () => {
		transport.isFailing = true;
		const t = await harness();
		await suspend(t, NOW);
		await settle(t);

		const standing = await t.run(async (ctx) =>
			readStandingSendingHold(ctx, await ctx.db.query('instanceSettings').first())
		);
		expect(standing?.channels.email.state).toBe('unavailable');
	});

	it('mails an admin who chose German in German, and the others in English', async () => {
		const t = await harness({}, { adminLocale: 'de' });
		await suspend(t, NOW);
		await settle(t);

		const byRecipient = Object.fromEntries(transport.sent.map((mail) => [mail.to, mail]));
		expect(byRecipient['admin@example.com']!.subject).toBe('Owlat: Versand ausgesetzt');
		expect(byRecipient['admin@example.com']!.html).toContain(
			'Der Versand startet von selbst wieder, sobald die Bounce-Rate der letzten 30 Tage unter 5 % liegt; aktuell sind es 12 %.'
		);
		expect(byRecipient['owner@example.com']!.subject).toBe('Owlat: sending is suspended');

		transport.sent = [];
		await resumeByCheck(t, NOW + 1);
		await settle(t);
		const resumed = Object.fromEntries(transport.sent.map((mail) => [mail.to, mail]));
		expect(resumed['admin@example.com']!.subject).toBe('Owlat: Versand wieder aktiv');
		expect(resumed['owner@example.com']!.subject).toBe('Owlat: sending resumed');
	});

	it('a failing webhook endpoint stops neither the transition nor the email', async () => {
		vi.mocked(fetchWithGuardedDispatcher).mockImplementation(
			async () => new Response('down', { status: 503 })
		);
		const t = await harness();

		await suspend(t);
		await settle(t);

		const settings = await t.run((ctx) => ctx.db.query('instanceSettings').first());
		expect(settings?.abuseStatus).toBe('suspended');
		expect(transport.sent).toHaveLength(2);
		const logs = await alertPayloads(t);
		expect(logs).toHaveLength(1);
		expect(logs[0]!.status).toBe('failed');
		expect(vi.mocked(fetchWithGuardedDispatcher).mock.calls.length).toBeGreaterThan(1);
	});

	it('a failing email stops neither the transition nor the webhook', async () => {
		transport.isFailing = true;
		const t = await harness();

		await suspend(t);
		await settle(t);

		const settings = await t.run((ctx) => ctx.db.query('instanceSettings').first());
		expect(settings?.abuseStatus).toBe('suspended');
		const logs = await alertPayloads(t);
		expect(logs).toHaveLength(1);
		expect(logs[0]!.status).toBe('success');
	});
});
