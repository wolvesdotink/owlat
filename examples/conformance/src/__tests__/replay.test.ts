/**
 * Full-pipeline replay: one message, driven through all three tiers with the
 * SHIPPED modules of the reference plugins.
 *
 * Tier 1 replays the agent pipeline (classification -> draft -> plugin agent
 * step -> automation trigger/condition/step -> webhook event). Tier 2 replays
 * the signed synchronous hook over the connected app's real HTTP handler,
 * including the adversarial paths: forged signature, replayed nonce, stale
 * timestamp, wrong app, wrong hook kind and a cross-tenant id. Tier 3 replays
 * the sandboxed job across the real plugin/worker wire contract.
 *
 * The single invariant every replay checks is the one the platform rests on: a
 * plugin can add work or caution, and can never produce a value that sends,
 * approves, or unblocks.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runSeedTest } from '@owlat/code-worker/jobs/seedTest';
import {
	buildSeedTestPayload,
	deliverabilityGate,
	createDeliverabilityGate,
	parseSeedTestResult,
	SEED_TEST_MAX_SEEDS,
	type DeliverabilityEmail,
} from '@owlat/example-deliverability-lab';
import {
	buildEscalationEventPayload,
	carefulAcknowledgementStrategy,
	detectEscalation,
	escalationAgentStep,
	escalationTrigger,
	priorityAccountCondition,
	requireOwnerStep,
} from '@owlat/example-escalation-guard';
import {
	createInMemoryApprovalRepository,
	createNonceGuard,
	handleSlackCallback,
	serveGateHook,
	signSlackRequest,
	SLACK_APPROVE_ACTION_ID,
	SLACK_REJECT_ACTION_ID,
	type ApprovalRequest,
	type SlackMessage,
} from '@owlat/example-slack-approvals';
import { applyRestrictOnlyGateResult } from '@owlat/plugin-host';
import { HOOK_HEADERS, signHookRequest, verifyHookResponse } from '../hookClient';

const ESCALATION = Object.freeze({
	inboundMessageId: 'msg-esc-1',
	from: 'ceo@acme.example',
	to: 'support@owlat.example',
	subject: 'Formal complaint — final notice',
	textBody: 'This is unacceptable. Our lawyer will be in touch and we are disputing the charge.',
});

const ORDINARY = Object.freeze({
	inboundMessageId: 'msg-ok-1',
	from: 'dev@globex.example',
	to: 'support@owlat.example',
	subject: 'Question about the API',
	textBody: 'Which endpoint returns the delivery status? Thanks.',
});

describe('tier 1 replay — the bundled agent pipeline', () => {
	it('holds an escalation for review and drives the automation and webhook legs', async () => {
		const stepResult = await escalationAgentStep.execute(ESCALATION);
		expect(stepResult.kind).toBe('caution');
		if (stepResult.kind !== 'caution') throw new Error('expected a caution');
		expect(stepResult.to).toBe('draft_ready');

		// The step's own output is what the plugin publishes onward — content-free.
		const verdict = detectEscalation(ESCALATION);
		const eventPayload = buildEscalationEventPayload(verdict);
		expect(eventPayload.level).toBe('escalate');
		expect(JSON.stringify(eventPayload)).not.toContain('lawyer');

		// Automation leg: the trigger fires, the priority condition branches, and
		// the step blocks the run until a human owner exists.
		const triggerConfig = escalationTrigger.parseConfig({ minimumLevel: 'escalate' });
		const firing = {
			contactId: 'contact-1',
			payload: { level: eventPayload.level, signals: [...eventPayload.signals] },
		};
		expect(escalationTrigger.matches(firing, triggerConfig)).toBe(true);
		expect(escalationTrigger.buildTriggerData?.(firing, triggerConfig)).toEqual({
			escalationLevel: 'escalate',
			escalationSignalCount: eventPayload.signalCount,
		});

		const conditionConfig = priorityAccountCondition.parseConfig({ domains: ['acme.example'] });
		expect(
			priorityAccountCondition.evaluate(
				{ contactEmail: ESCALATION.from, contactProperties: {} },
				conditionConfig
			)
		).toBe(true);

		const stepConfig = requireOwnerStep.parseConfig({ ownerProperty: 'escalationOwner' });
		expect(
			await requireOwnerStep.execute(
				{ contactEmail: ESCALATION.from, contactProperties: {} },
				stepConfig
			)
		).toMatchObject({ kind: 'failed' });
		expect(
			await requireOwnerStep.execute(
				{ contactEmail: ESCALATION.from, contactProperties: { escalationOwner: 'dana' } },
				stepConfig
			)
		).toEqual({ kind: 'completed' });
	});

	it('lets ordinary mail through untouched, contributing nothing', async () => {
		const stepResult = await escalationAgentStep.execute(ORDINARY);
		expect(stepResult).toEqual({ kind: 'continue', output: { level: 'none', signals: [] } });

		const triggerConfig = escalationTrigger.parseConfig({ minimumLevel: 'escalate' });
		expect(
			escalationTrigger.matches({ contactId: 'c', payload: { level: 'none' } }, triggerConfig)
		).toBe(false);
		expect(buildEscalationEventPayload(detectEscalation(ORDINARY)).signalCount).toBe(0);
	});

	it('drafts the acknowledgement through the budgeted host dispatch only', async () => {
		const calls: string[] = [];
		const result = await carefulAcknowledgementStrategy.generate(
			{
				audience: 'organization',
				context: ESCALATION.textBody,
				classification: {
					category: 'complaint',
					intent: 'escalation',
					sentiment: 'negative',
					priority: 'high',
				},
				toneInstruction: 'Calm and factual.',
				signatureInstruction: 'Sign as the support team.',
				voiceSection: 'Support voice',
			},
			{
				llm: {
					async generate(request) {
						calls.push(request.tier);
						return { text: 'Thanks for writing. Dana will follow up today.' };
					},
				},
			}
		);
		expect(calls).toEqual(['fast']);
		expect(result.draftBody).toBe('Thanks for writing. Dana will follow up today.');
	});
});

describe('tier 2 replay — the signed synchronous hook', () => {
	const SECRET = 'connected-app-shared-secret';
	const APP_ID = 'app-conformance';
	const ORG = 'org-1';
	const TS = 1_800_000_000;
	const NOW = TS * 1000;
	const CONFIG = { requiredApprovals: 1, ttlMs: 60 * 60 * 1000 };

	function connection() {
		return { organizationId: ORG, connectedAppId: APP_ID, secret: SECRET, config: CONFIG };
	}

	function notifier() {
		const messages: SlackMessage[] = [];
		const requests: ApprovalRequest[] = [];
		return {
			messages,
			requests,
			notifier: {
				async postApprovalRequest(request: ApprovalRequest) {
					requests.push(request);
					messages.push({ channel: '#approvals', text: 'held', blocks: [] });
				},
			},
		};
	}

	async function callGate(
		overrides: Parameters<typeof signHookRequest>[0],
		context: {
			readonly repository: ReturnType<typeof createInMemoryApprovalRepository>;
			readonly sink: ReturnType<typeof notifier>;
			readonly nowMs?: number;
			readonly nonceGuard?: ReturnType<typeof createNonceGuard>;
		}
	) {
		const request = await signHookRequest(overrides);
		const response = await serveGateHook({
			connection: connection(),
			headers: request.headers,
			rawBody: request.rawBody,
			nowMs: context.nowMs ?? NOW,
			repository: context.repository,
			notifier: context.sink.notifier,
			...(context.nonceGuard ? { nonceGuard: context.nonceGuard } : {}),
		});
		return { request, response };
	}

	function gateArgs(over: Partial<Parameters<typeof signHookRequest>[0]> = {}) {
		return {
			secret: SECRET,
			appId: APP_ID,
			nonce: 'nonce-1',
			timestampSeconds: TS,
			payload: { messageId: 'draft-1', subject: 'Re: Formal complaint' },
			...over,
		};
	}

	it('holds the first call, posts to Slack, and signs its restrict-only answer', async () => {
		const repository = createInMemoryApprovalRepository();
		const sink = notifier();
		const { request, response } = await callGate(gateArgs(), { repository, sink });

		expect(response.status).toBe(200);
		const verdict = JSON.parse(response.body) as { outcome: string; reason?: string };
		expect(verdict.outcome).toBe('objection');
		expect(sink.messages).toHaveLength(1);
		expect(
			await verifyHookResponse({
				secret: SECRET,
				appId: APP_ID,
				requestNonce: 'nonce-1',
				headers: response.headers,
				body: response.body,
			})
		).toBe(true);
		expect(request.headers[HOOK_HEADERS.appId]).toBe(APP_ID);
	});

	it('clears the hold only after a real human quorum approves inside the window', async () => {
		const repository = createInMemoryApprovalRepository();
		const sink = notifier();
		await callGate(gateArgs(), { repository, sink });

		const interaction = JSON.stringify({
			type: 'block_actions',
			user: { id: 'U-dana' },
			actions: [{ action_id: SLACK_APPROVE_ACTION_ID, value: 'draft-1' }],
		});
		const rawBody = `payload=${encodeURIComponent(interaction)}`;
		const callback = await handleSlackCallback({
			organizationId: ORG,
			signingSecret: 'slack-signing-secret',
			rawBody,
			signatureHeader: await signSlackRequest('slack-signing-secret', TS, rawBody),
			timestampHeader: String(TS),
			nowMs: NOW,
			repository,
		});
		expect(callback.status).toBe('recorded');

		const second = await callGate(gateArgs({ nonce: 'nonce-2' }), { repository, sink });
		expect(JSON.parse(second.response.body)).toEqual({ outcome: 'no-objection' });
		// Even the strongest verdict cannot flip a core-blocked decision.
		const coreBlocked = { allowed: false as const, objections: ['core gate objected'] };
		expect(applyRestrictOnlyGateResult(coreBlocked, { outcome: 'no-objection' }).allowed).toBe(
			false
		);
	});

	it('keeps holding after a rejection, and after the window expires', async () => {
		const repository = createInMemoryApprovalRepository();
		const sink = notifier();
		await callGate(gateArgs({ payload: { messageId: 'draft-reject' } }), { repository, sink });

		const interaction = JSON.stringify({
			type: 'block_actions',
			user: { id: 'U-sam' },
			actions: [{ action_id: SLACK_REJECT_ACTION_ID, value: 'draft-reject' }],
		});
		const rawBody = `payload=${encodeURIComponent(interaction)}`;
		await handleSlackCallback({
			organizationId: ORG,
			signingSecret: 'slack-signing-secret',
			rawBody,
			signatureHeader: await signSlackRequest('slack-signing-secret', TS, rawBody),
			timestampHeader: String(TS),
			nowMs: NOW,
			repository,
		});
		const rejected = await callGate(
			gateArgs({ nonce: 'nonce-r', payload: { messageId: 'draft-reject' } }),
			{ repository, sink }
		);
		expect(JSON.parse(rejected.response.body).outcome).toBe('objection');

		// A different draft, never voted on, past its window.
		await callGate(gateArgs({ nonce: 'nonce-e', payload: { messageId: 'draft-expire' } }), {
			repository,
			sink,
		});
		const expired = await callGate(
			gateArgs({
				nonce: 'nonce-e2',
				timestampSeconds: TS + 2 * 60 * 60,
				payload: { messageId: 'draft-expire' },
			}),
			{ repository, sink, nowMs: NOW + 2 * 60 * 60 * 1000 }
		);
		expect(JSON.parse(expired.response.body).outcome).toBe('objection');
	});

	it('refuses every unauthenticated or off-contract request', async () => {
		const repository = createInMemoryApprovalRepository();
		const sink = notifier();

		const forged = await callGate(gateArgs({ signatureOverride: 'v1=deadbeef' }), {
			repository,
			sink,
		});
		expect(forged.response.status).toBe(401);

		const wrongSecret = await callGate(gateArgs({ secret: 'not-the-secret' }), {
			repository,
			sink,
		});
		expect(wrongSecret.response.status).toBe(401);

		const wrongApp = await callGate(gateArgs({ appId: 'app-someone-else' }), {
			repository,
			sink,
		});
		expect(wrongApp.response.status).toBe(401);

		const stale = await callGate(gateArgs({ nonce: 'nonce-old' }), {
			repository,
			sink,
			nowMs: NOW + 10 * 60 * 1000,
		});
		expect(stale.response.status).toBe(401);

		const wrongVersion = await callGate(gateArgs({ versionOverride: 'v2' }), {
			repository,
			sink,
		});
		expect(wrongVersion.response.status).toBe(401);

		const wrongKind = await callGate(gateArgs({ hookKind: 'draft', nonce: 'nonce-draft' }), {
			repository,
			sink,
		});
		expect(wrongKind.response.status).toBe(400);

		// Nothing above created an approval or notified Slack.
		expect(sink.messages).toHaveLength(0);
	});

	it('refuses a replayed nonce when the app runs a replay guard', async () => {
		const repository = createInMemoryApprovalRepository();
		const sink = notifier();
		const nonceGuard = createNonceGuard();

		const first = await callGate(gateArgs(), { repository, sink, nonceGuard });
		expect(first.response.status).toBe(200);
		const replay = await callGate(gateArgs(), { repository, sink, nonceGuard });
		expect(replay.response.status).toBe(401);
	});

	it('keeps one tenant approval unreachable from another tenant', async () => {
		const repository = createInMemoryApprovalRepository();
		const sink = notifier();
		await callGate(gateArgs(), { repository, sink });

		const interaction = JSON.stringify({
			type: 'block_actions',
			user: { id: 'U-intruder' },
			actions: [{ action_id: SLACK_APPROVE_ACTION_ID, value: 'draft-1' }],
		});
		const rawBody = `payload=${encodeURIComponent(interaction)}`;
		const foreign = await handleSlackCallback({
			organizationId: 'org-attacker',
			signingSecret: 'slack-signing-secret',
			rawBody,
			signatureHeader: await signSlackRequest('slack-signing-secret', TS, rawBody),
			timestampHeader: String(TS),
			nowMs: NOW,
			repository,
		});
		expect(foreign.status).toBe('unknown_request');

		const still = await callGate(gateArgs({ nonce: 'nonce-after' }), { repository, sink });
		expect(JSON.parse(still.response.body).outcome).toBe('objection');
	});
});

describe('tier 3 replay — the sandboxed seed-list job', () => {
	const FIXTURE = new URL(
		'../../../../fixtures/deliverability-lab/seed-test-payload.json',
		import.meta.url
	);

	async function fixtureEmail(): Promise<{
		readonly email: DeliverabilityEmail;
		readonly seeds: readonly string[];
	}> {
		const raw = JSON.parse(await readFile(FIXTURE, 'utf8')) as {
			subject: string;
			from: string;
			html?: string;
			text?: string;
			seeds: string[];
		};
		return {
			email: { subject: raw.subject, from: raw.from, html: raw.html, text: raw.text },
			seeds: raw.seeds,
		};
	}

	it('round-trips the plugin payload through the worker job and back', async () => {
		const { email, seeds } = await fixtureEmail();
		const request = buildSeedTestPayload(email, seeds);
		expect(request.jobKind).toBe('plugin.deliverability-lab.seed-test');

		const resultJson = runSeedTest(request.payload);
		const parsed = parseSeedTestResult(resultJson);
		expect(parsed).not.toBeNull();
		expect(parsed?.placements).toHaveLength(seeds.length);
		expect(parsed?.seeds).toBe(seeds.length);
		expect((parsed?.inbox ?? 0) + (parsed?.promotions ?? 0) + (parsed?.spam ?? 0)).toBe(
			seeds.length
		);
		for (const placement of parsed?.placements ?? []) {
			expect(['inbox', 'promotions', 'spam']).toContain(placement.folder);
			expect(seeds).toContain(placement.address);
		}
	});

	it('is deterministic, so the same job replays to the same result', async () => {
		const { email, seeds } = await fixtureEmail();
		const request = buildSeedTestPayload(email, seeds);
		expect(runSeedTest(request.payload)).toBe(runSeedTest(request.payload));
	});

	it('refuses a payload the host would reject before enqueueing it', async () => {
		const { email } = await fixtureEmail();
		expect(() => buildSeedTestPayload(email, [])).toThrow();
		expect(() => buildSeedTestPayload(email, ['not-an-address'])).toThrow();
		expect(() =>
			buildSeedTestPayload(
				email,
				Array.from({ length: SEED_TEST_MAX_SEEDS + 1 }, (_, i) => `seed${i}@example.test`)
			)
		).toThrow();
	});

	it('fails closed on a malformed worker result rather than trusting it', () => {
		for (const output of ['not json', '{}', '{"placements":"nope"}', 'null']) {
			expect(parseSeedTestResult(output), output).toBeNull();
		}
	});
});

describe('cross-tier restrict-only invariant', () => {
	it('objects to a spam-shaped draft and stays out of the way of a clean one', async () => {
		const controller = new AbortController();
		const spammy = {
			from: 'sales@acme.example',
			to: 'lead@globex.example',
			subject: 'ACT NOW!!! FREE MONEY GUARANTEED',
			draftBody: 'CLICK HERE NOW!!! 100% FREE!!! ACT NOW!!! LIMITED TIME!!!',
		};
		const clean = {
			from: 'support@acme.example',
			to: 'dev@globex.example',
			subject: 'Re: API question',
			draftBody: 'The delivery status endpoint is /v1/messages/:id.',
		};

		const objected = await deliverabilityGate.evaluate(spammy, { signal: controller.signal });
		expect(objected).toEqual({ outcome: 'objection', reason: expect.any(String) });

		const quiet = await deliverabilityGate.evaluate(clean, { signal: controller.signal });
		expect(quiet).toEqual({ outcome: 'no-objection' });
	});

	it('objects when its own analysis throws, never approving on error', async () => {
		const exploding = createDeliverabilityGate({
			remoteScoreHook: () => {
				throw new Error('vendor exploded');
			},
			remoteDeadlineMs: 10,
		});
		const result = await exploding.evaluate(
			{
				from: 'a@acme.example',
				to: 'b@globex.example',
				subject: 'Hello',
				draftBody: 'Plain body.',
			},
			{ signal: new AbortController().signal }
		);
		// The concrete fail-closed value, not set membership: deleting the gate's
		// catch block must turn THIS test red.
		expect(result).toEqual({
			outcome: 'objection',
			reason: expect.stringContaining('holding for review'),
		});
	});

	it('cannot turn a core-blocked decision into an allowed one', () => {
		const blocked = {
			allowed: false as const,
			objections: ['Attachment failed the scan'],
		};
		expect(applyRestrictOnlyGateResult(blocked, { outcome: 'no-objection' }).allowed).toBe(false);
		const allowed = { allowed: true as const, objections: [] as const };
		expect(
			applyRestrictOnlyGateResult(allowed, { outcome: 'objection', reason: 'hold' }).allowed
		).toBe(false);
	});
});
