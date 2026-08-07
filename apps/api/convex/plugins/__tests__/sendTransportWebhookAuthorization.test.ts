/**
 * Feedback deliveries are authorized like everything else a plugin does (the
 * seams plan's D6/P2.2).
 *
 * The route is called by the PROVIDER, not by the plugin, which is exactly why
 * this seam has to exist: without it, turning a plugin off or revoking its grant
 * would stop its sends and leave an endpoint quietly writing to the delivery
 * record on its behalf. Every case below is a way an operator can have withdrawn
 * consent, and the answer must be the same one the send path gives.
 *
 * The uniformity of the sequence itself (one shared implementation, no second
 * copy) is `hostedSeamUniformity.test.ts`; what this adds is the seam's own
 * decisions — ownership, and the operation literal its audit rows carry.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => vi.fn(async () => undefined));

const KIND = 'plugin.mail-pack.postmark';
const OTHER_KIND = 'plugin.other-pack.relay';

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
				replay: Object.freeze({
					timestampHeader: 'x-postmark-timestamp',
					toleranceSeconds: 300,
				}),
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

vi.mock('../plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/mail-pack',
			manifest: Object.freeze({
				id: 'mail-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['send:transport']),
				flag: Object.freeze({ default: false, requiredEnvVars: Object.freeze(['POSTMARK_TOKEN']) }),
			}),
		}),
		// Registered, enabled and granted, but it owns no catalogued webhook — so
		// the only thing that can deny its claim on `mail-pack`'s kind is the
		// ownership check.
		Object.freeze({
			packageName: '@acme/other-pack',
			manifest: Object.freeze({
				id: 'other-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['send:transport']),
				flag: Object.freeze({ default: false, requiredEnvVars: Object.freeze([]) }),
			}),
		}),
	]),
}));

vi.mock('../audit', () => ({ recordHostedPluginAudit: audit }));

import { _resetSingletonOrgCacheForTests } from '../../lib/sessionOrganization';
import { authorizeDelivery, recordOutcome } from '../sendTransportWebhookAuthorization';

const authorizeHandler = (
	authorizeDelivery as unknown as {
		_handler: (ctx: unknown, args: { pluginId: string; transportKind: string }) => Promise<boolean>;
	}
)._handler;
const outcomeHandler = (
	recordOutcome as unknown as {
		_handler: (
			ctx: unknown,
			args: { pluginId: string; transportKind: string; outcome: 'completed' | 'failed' }
		) => Promise<void>;
	}
)._handler;

function fakeContext(isEnabled: boolean, isGranted: boolean) {
	return {
		runQuery: vi.fn(async () => ({ page: [{ id: 'organization-id' }] })),
		db: {
			query: vi.fn(() => ({
				first: vi.fn(async () => ({
					featureFlags: { 'plugin.mail-pack': isEnabled, 'plugin.other-pack': isEnabled },
					pluginCapabilityGrants: {
						'plugin.mail-pack': { 'send:transport': isGranted },
						'plugin.other-pack': { 'send:transport': isGranted },
					},
				})),
			})),
		},
	};
}

describe('bundled send transport feedback authorization', () => {
	beforeEach(() => {
		_resetSingletonOrgCacheForTests();
		audit.mockClear();
		vi.unstubAllEnvs();
		vi.stubEnv('POSTMARK_TOKEN', 'present');
	});

	it('authorizes the webhook-declaring kind its owner claims', async () => {
		await expect(
			authorizeHandler(fakeContext(true, true), { pluginId: 'mail-pack', transportKind: KIND })
		).resolves.toBe(true);
	});

	it.each([
		['a cross-plugin claim', 'other-pack', KIND],
		['a transport that declares no webhook', 'other-pack', OTHER_KIND],
		['a core kind', 'mail-pack', 'ses'],
		['an unknown kind', 'mail-pack', 'plugin.mail-pack.unknown'],
	] as const)('refuses %s without auditing under the named plugin', async (_l, pluginId, kind) => {
		await expect(
			authorizeHandler(fakeContext(true, true), { pluginId, transportKind: kind })
		).resolves.toBe(false);
		expect(audit).not.toHaveBeenCalled();
	});

	it.each([
		['a disabled plugin', false, true, 'present'],
		['a revoked grant', true, false, 'present'],
		['a missing required environment variable', true, true, ''],
	] as const)('refuses %s and audits the denial', async (_label, isEnabled, isGranted, token) => {
		vi.stubEnv('POSTMARK_TOKEN', token);
		await expect(
			authorizeHandler(fakeContext(isEnabled, isGranted), {
				pluginId: 'mail-pack',
				transportKind: KIND,
			})
		).resolves.toBe(false);
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'mail-pack' }),
			'transport.feedback',
			'denied',
			{ reasonCode: 'access_denied' }
		);
	});

	it('records an inbound outcome as feedback, never as a send', async () => {
		// `transport.send` would file events this deployment RECEIVED under the row
		// that means messages it sent.
		await outcomeHandler(fakeContext(true, true), {
			pluginId: 'mail-pack',
			transportKind: KIND,
			outcome: 'completed',
		});
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'mail-pack' }),
			'transport.feedback',
			'completed',
			{}
		);
	});

	it('throws rather than misattribute a cross-plugin outcome', async () => {
		await expect(
			outcomeHandler(fakeContext(true, true), {
				pluginId: 'other-pack',
				transportKind: KIND,
				outcome: 'completed',
			})
		).rejects.toThrow('Invalid bundled send transport feedback attribution');
		expect(audit).not.toHaveBeenCalled();
	});
});
