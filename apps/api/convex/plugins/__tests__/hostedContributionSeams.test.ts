/**
 * Every hosted contribution seam runs ONE authorization sequence — parse the
 * plugin id, look the kind up in its catalog, compare ownership, resolve the
 * singleton organization, apply the flag / grant / environment gate, audit a
 * denial as `access_denied` — through `hostedContributionAuthorization`. That
 * there is exactly one implementation is `scripts/check-hosted-seams.sh`; what
 * this table proves is that every seam's DOOR behaves the same way on the same
 * inputs, and that the only things a seam is allowed to differ in (its
 * operation literal, its failure reason code, its attribution error, which
 * catalog it asks) are the ones it actually differs in.
 *
 * The webhook seam is the one worth reading twice: the route is called by the
 * PROVIDER, not by the plugin, so without it turning a plugin off would stop
 * its sends and leave an endpoint quietly writing to the delivery record on
 * its behalf. Every denial below is a way an operator can have withdrawn
 * consent, and the answer must be the one the send path gives.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => vi.fn(async () => undefined));

// One registered plugin per seam, each owning one catalogued kind; `other-pack`
// is registered, enabled and granted but owns no kind, so the only thing that
// can deny its claim on someone else's kind is the ownership check; and the
// gate and cron catalogs each list a kind whose plugin is NOT registered.
vi.mock('../../agent/steps/catalog', () => ({
	pluginAgentStepDefinition: (kind: string) =>
		kind === 'plugin.policy-pack.spam-score'
			? { kind, pluginId: 'policy-pack', requiredCapability: 'agent:step' }
			: undefined,
}));

vi.mock('../../automations/steps/catalog', () => ({
	pluginStepCatalogEntry: (kind: string) =>
		kind === 'plugin.deliverability.notify'
			? {
					kind,
					pluginId: 'deliverability',
					localId: 'notify',
					requiredCapability: 'automation:step',
				}
			: undefined,
}));

vi.mock('../autonomyGateCatalog.generated', () => ({
	BUNDLED_PLUGIN_AUTONOMY_GATE_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.policy-pack.final-review',
			pluginId: 'policy-pack',
			label: 'Final policy review',
			timeoutMs: 500,
			requiredEnvVars: Object.freeze(['POLICY_KEY']),
			requiredCapability: 'send:gate',
		}),
		Object.freeze({
			kind: 'plugin.unregistered-pack.final-review',
			pluginId: 'unregistered-pack',
			label: 'Unregistered policy review',
			timeoutMs: 500,
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'send:gate',
		}),
	]),
}));

vi.mock('../cronCatalog.generated', () => ({
	BUNDLED_PLUGIN_CRON_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.seed-lab.refresh-scores',
			pluginId: 'seed-lab',
			label: 'Refresh seed scores',
			intervalMinutes: 360,
			timeoutMs: 30_000,
			requiredEnvVars: Object.freeze(['SEED_TOKEN']),
			requiredCapability: 'scheduler:cron',
		}),
		Object.freeze({
			kind: 'plugin.unregistered-lab.refresh-scores',
			pluginId: 'unregistered-lab',
			label: 'Unregistered refresh',
			intervalMinutes: 360,
			timeoutMs: 30_000,
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'scheduler:cron',
		}),
	]),
}));

vi.mock('../sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.mail-pack.postmark',
			pluginId: 'mail-pack',
			localId: 'postmark',
			label: 'Postmark',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'send:transport',
		}),
		Object.freeze({
			kind: 'plugin.other-pack.relay',
			pluginId: 'other-pack',
			localId: 'relay',
			label: 'Relay',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../sendTransportWebhookCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.mail-pack.postmark',
			pluginId: 'mail-pack',
			localId: 'postmark',
			signature: Object.freeze({
				header: 'x-postmark-signature',
				algorithm: 'hmac-sha256',
				encoding: 'hex',
				secretEnvVar: 'PLUGIN_POSTMARK_WEBHOOK_SECRET',
				replay: Object.freeze({ timestampHeader: 'x-postmark-timestamp', toleranceSeconds: 300 }),
			}),
			storeRawPayload: false,
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../sendTransportWebhookModules.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_MODULES: Object.freeze([
		Object.freeze({
			kind: 'plugin.mail-pack.postmark',
			pluginId: 'mail-pack',
			module: { parseEvents: () => [] },
		}),
	]),
}));

vi.mock('../plugins.generated', () => {
	const plugin = (id: string, capabilities: readonly string[], envVar: string | null) =>
		Object.freeze({
			packageName: `@acme/${id}`,
			manifest: Object.freeze({
				id,
				version: '1.0.0',
				capabilities: Object.freeze([...capabilities]),
				flag: Object.freeze({
					default: false,
					requiredEnvVars: Object.freeze(envVar === null ? [] : [envVar]),
				}),
			}),
		});
	return {
		bundledPluginComposition: Object.freeze([
			plugin('policy-pack', ['agent:step', 'send:gate'], 'POLICY_KEY'),
			plugin('deliverability', ['automation:step'], 'DELIVERABILITY_KEY'),
			plugin('seed-lab', ['scheduler:cron'], 'SEED_TOKEN'),
			plugin('mail-pack', ['send:transport'], 'POSTMARK_TOKEN'),
			plugin('other-pack', ['send:transport'], null),
		]),
	};
});

vi.mock('../audit', () => ({ recordHostedPluginAudit: audit }));

import { _resetSingletonOrgCacheForTests } from '../../lib/sessionOrganization';
import * as agentStep from '../agentStepAuthorization';
import * as automationStep from '../automationStepAuthorization';
import * as autonomyGate from '../autonomyGateAuthorization';
import * as cron from '../cronAuthorization';
import * as sendTransportWebhook from '../sendTransportWebhookAuthorization';

type Args = Record<string, unknown>;
type Handler<Result> = (ctx: unknown, args: Args) => Promise<Result>;

const handlerOf = <Result>(fn: unknown): Handler<Result> =>
	(fn as { _handler: Handler<Result> })._handler;

interface Seam {
	readonly name: string;
	readonly authorize: Handler<boolean>;
	readonly recordOutcome: Handler<void>;
	/** The arg the seam spells its kind under. */
	readonly kindArg: string;
	readonly pluginId: string;
	readonly kind: string;
	readonly capability: string;
	readonly envVar: string;
	readonly operation: string;
	readonly failureReasonCode: string;
	readonly attributionError: string;
	/** Whether `recordOutcome` takes a caller-supplied bounded reason code. */
	readonly explicitReasonCode?: string;
	/** A catalogued kind whose plugin is no longer registered. */
	readonly unregistered?: { readonly pluginId: string; readonly kind: string };
	/** Further claims the ownership check alone must refuse, without auditing. */
	readonly alsoRefuses?: readonly (readonly [label: string, pluginId: string, kind: string])[];
}

const SEAMS: readonly Seam[] = [
	{
		name: 'agent step',
		authorize: handlerOf(agentStep.authorizeExecution),
		recordOutcome: handlerOf(agentStep.recordOutcome),
		kindArg: 'stepKind',
		pluginId: 'policy-pack',
		kind: 'plugin.policy-pack.spam-score',
		capability: 'agent:step',
		envVar: 'POLICY_KEY',
		operation: 'agent.step',
		failureReasonCode: 'agent_step_failed',
		attributionError: 'Invalid bundled agent step attribution',
	},
	{
		name: 'automation step',
		authorize: handlerOf(automationStep.authorizeExecution),
		recordOutcome: handlerOf(automationStep.recordOutcome),
		kindArg: 'stepKind',
		pluginId: 'deliverability',
		kind: 'plugin.deliverability.notify',
		capability: 'automation:step',
		envVar: 'DELIVERABILITY_KEY',
		operation: 'automation.step',
		failureReasonCode: 'automation_step_failed',
		attributionError: 'Invalid bundled automation step attribution',
	},
	{
		name: 'autonomy gate',
		authorize: handlerOf(autonomyGate.authorizeExecution),
		recordOutcome: handlerOf(autonomyGate.recordOutcome),
		kindArg: 'gateKind',
		pluginId: 'policy-pack',
		kind: 'plugin.policy-pack.final-review',
		capability: 'send:gate',
		envVar: 'POLICY_KEY',
		operation: 'autonomy.gate',
		failureReasonCode: 'autonomy_gate_failed',
		attributionError: 'Invalid bundled autonomy gate attribution',
		explicitReasonCode: 'autonomy_gate_timeout',
		unregistered: { pluginId: 'unregistered-pack', kind: 'plugin.unregistered-pack.final-review' },
	},
	{
		name: 'plugin cron',
		authorize: handlerOf(cron.authorizeExecution),
		recordOutcome: handlerOf(cron.recordOutcome),
		kindArg: 'cronKind',
		pluginId: 'seed-lab',
		kind: 'plugin.seed-lab.refresh-scores',
		capability: 'scheduler:cron',
		envVar: 'SEED_TOKEN',
		operation: 'cron.run',
		failureReasonCode: 'cron_failed',
		attributionError: 'Invalid bundled cron attribution',
		explicitReasonCode: 'cron_timeout',
		unregistered: { pluginId: 'unregistered-lab', kind: 'plugin.unregistered-lab.refresh-scores' },
	},
	{
		name: 'send transport feedback',
		authorize: handlerOf(sendTransportWebhook.authorizeDelivery),
		recordOutcome: handlerOf(sendTransportWebhook.recordOutcome),
		kindArg: 'transportKind',
		pluginId: 'mail-pack',
		kind: 'plugin.mail-pack.postmark',
		capability: 'send:transport',
		envVar: 'POSTMARK_TOKEN',
		// `transport.send` would file events this deployment RECEIVED under the
		// row that means messages it sent.
		operation: 'transport.feedback',
		failureReasonCode: 'provider_dispatch_failed',
		attributionError: 'Invalid bundled send transport feedback attribution',
		alsoRefuses: [
			['a transport that declares no webhook', 'other-pack', 'plugin.other-pack.relay'],
			['a core kind', 'mail-pack', 'ses'],
		],
	},
];

const PLUGIN_IDS = ['policy-pack', 'deliverability', 'seed-lab', 'mail-pack', 'other-pack'];

/** An org-scoped context whose settings row enables and grants every plugin the same way. */
function fakeContext(
	isEnabled: boolean,
	isGranted: boolean,
	organizations: readonly { id: string }[] = [{ id: 'organization-id' }]
) {
	const featureFlags: Record<string, boolean> = {};
	const pluginCapabilityGrants: Record<string, Record<string, boolean>> = {};
	for (const id of PLUGIN_IDS) {
		featureFlags[`plugin.${id}`] = isEnabled;
		pluginCapabilityGrants[`plugin.${id}`] = Object.fromEntries(
			SEAMS.map((seam) => [seam.capability, isGranted])
		);
	}
	return {
		runQuery: vi.fn(async () => ({ page: organizations })),
		db: {
			query: vi.fn(() => ({
				first: vi.fn(async () => ({ featureFlags, pluginCapabilityGrants })),
			})),
		},
	};
}

describe.each(SEAMS)('hosted seam: $name', (seam) => {
	const claim = (pluginId: string, kind: string): Args => ({ pluginId, [seam.kindArg]: kind });
	const deniedAudit = () =>
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: seam.pluginId }),
			seam.operation,
			'denied',
			{ reasonCode: 'access_denied' }
		);

	beforeEach(() => {
		_resetSingletonOrgCacheForTests();
		audit.mockClear();
		vi.unstubAllEnvs();
		vi.stubEnv(seam.envVar, 'present');
	});

	it('authorizes the catalogued kind its owner claims', async () => {
		await expect(
			seam.authorize(fakeContext(true, true), claim(seam.pluginId, seam.kind))
		).resolves.toBe(true);
		expect(audit).not.toHaveBeenCalled();
	});

	it.each([
		['a cross-plugin claim', 'other-pack', seam.kind],
		['an uncatalogued kind', seam.pluginId, `${seam.kind}-missing`],
		['a malformed plugin id', 'Not A Plugin Id', seam.kind],
		...(seam.alsoRefuses ?? []),
	])('refuses %s without auditing under the named plugin', async (_label, pluginId, kind) => {
		await expect(seam.authorize(fakeContext(true, true), claim(pluginId, kind))).resolves.toBe(
			false
		);
		expect(audit).not.toHaveBeenCalled();
	});

	it.each([
		['a disabled plugin', false, true, 'present'],
		['a revoked grant', true, false, 'present'],
		['a missing required environment variable', true, true, ''],
	] as const)('refuses %s and audits the denial', async (_label, isEnabled, isGranted, env) => {
		vi.stubEnv(seam.envVar, env);
		await expect(
			seam.authorize(fakeContext(isEnabled, isGranted), claim(seam.pluginId, seam.kind))
		).resolves.toBe(false);
		deniedAudit();
	});

	it.each([
		['zero organizations', []],
		['multiple organizations', [{ id: 'org-one' }, { id: 'org-two' }]],
	] as const)('denies safely with %s', async (_label, organizations) => {
		await expect(
			seam.authorize(fakeContext(true, true, organizations), claim(seam.pluginId, seam.kind))
		).resolves.toBe(false);
		expect(audit).not.toHaveBeenCalled();
	});

	if (seam.unregistered !== undefined) {
		const { pluginId, kind } = seam.unregistered;
		it('denies a catalogued kind whose plugin is no longer registered', async () => {
			await expect(seam.authorize(fakeContext(true, true), claim(pluginId, kind))).resolves.toBe(
				false
			);
			expect(audit).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ pluginId }),
				seam.operation,
				'denied',
				{ reasonCode: 'access_denied' }
			);
		});
	}

	it('records a completed outcome with no reason code', async () => {
		await seam.recordOutcome(fakeContext(true, true), {
			...claim(seam.pluginId, seam.kind),
			outcome: 'completed',
		});
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: seam.pluginId }),
			seam.operation,
			'completed',
			{}
		);
	});

	it('records a failed outcome under the seam’s fixed reason code', async () => {
		await seam.recordOutcome(fakeContext(true, true), {
			...claim(seam.pluginId, seam.kind),
			outcome: 'failed',
		});
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: seam.pluginId }),
			seam.operation,
			'failed',
			{ reasonCode: seam.failureReasonCode }
		);
	});

	if (seam.explicitReasonCode !== undefined) {
		const reasonCode = seam.explicitReasonCode;
		it('records a bounded caller-supplied reason code on a failure', async () => {
			await seam.recordOutcome(fakeContext(true, true), {
				...claim(seam.pluginId, seam.kind),
				outcome: 'failed',
				reasonCode,
			});
			expect(audit).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ pluginId: seam.pluginId }),
				seam.operation,
				'failed',
				{ reasonCode }
			);
		});
	}

	it.each([
		['a cross-plugin outcome', 'other-pack', seam.kind],
		['an uncatalogued kind', seam.pluginId, `${seam.kind}-missing`],
	])('throws rather than misattribute %s', async (_label, pluginId, kind) => {
		await expect(
			seam.recordOutcome(fakeContext(true, true), {
				...claim(pluginId, kind),
				outcome: 'completed',
			})
		).rejects.toThrow(seam.attributionError);
		expect(audit).not.toHaveBeenCalled();
	});
});
