/**
 * P3.1 — CONTRACT PARITY, the host half.
 *
 * A bundled transport that declares configuration of its own is SENT through the
 * instance it was addressed to: the host resolves that instance's variables and
 * hands the module exactly those. This file pins the three properties that makes
 * or breaks:
 *
 *  1. THE CREDENTIAL IS THE INSTANCE'S. The default instance reads the base
 *     names, `#eu` reads them under `__EU`, and the module sees them under the
 *     BASE name either way — so a transport cannot accidentally be written
 *     against one instance's spelling.
 *  2. NOTHING ELSE IS HANDED OVER. Not a variable the transport never declared,
 *     not one outside the `PLUGIN_` namespace, and never the governance handles
 *     on the governed dispatch input.
 *  3. THE PROMISES ARE PAIRS. `deduplicatesOnIdempotencyKey: true` without a
 *     `buildSystemMailExtras` export is refused at registry load, which is the
 *     replacement for the blanket refusal the catalog used to make while the
 *     plugin tier had no extras contract at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePluginId, pluginNamespacedKind } from '@owlat/plugin-kit';
import { createHostedSendProvider } from '../pluginProvider';
import { EmailErrorCode, type DispatchExtrasInput } from '../types';
import type { SendTransportRecord } from '../transports';

const KIND = pluginNamespacedKind(parsePluginId('mail-pack'), 'postmark');
const PLUGIN_ID = parsePluginId('mail-pack');

const params = {
	to: 'to@example.com',
	from: 'from@example.com',
	subject: 'Subject',
	html: '<p>Hello</p>',
};

const CONFIG_SPEC = {
	instanceEnvVars: ['PLUGIN_POSTMARK_TOKEN', 'PLUGIN_POSTMARK_STREAM'],
	requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'],
};

function transportRecord(instanceKey: string | null): SendTransportRecord {
	return Object.freeze({
		id: instanceKey === null ? KIND : `${KIND}#${instanceKey}`,
		kind: KIND,
		instanceKey,
		label: 'Postmark',
		retryDelays: [10],
		requiredEnvVars: [],
		pluginId: PLUGIN_ID,
	});
}

function facts(): DispatchExtrasInput {
	return {
		idempotencyKey: 'send-1',
		workAttemptId: 'attempt-1',
		organizationId: 'org-1',
		messageType: 'campaign',
		deliveryDomain: 'production',
		routingReentryToken: 'reentry-token-nobody-else-may-hold',
		routingReentry: {
			envelopeInput: { secret: true },
			retryState: { attempt: 1, startedAt: 0, idempotencyKey: 'send-1' },
		},
		routingLease: 'lease-nobody-else-may-hold',
		ipPool: 'transactional',
		warmupOverflowEnabled: true,
		engagementScore: 42,
		relayReturnPathHost: 'bounce.example.com',
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('per-instance configuration reaches the module', () => {
	beforeEach(() => {
		vi.stubEnv('PLUGIN_POSTMARK_TOKEN', 'default-token');
		vi.stubEnv('PLUGIN_POSTMARK_STREAM', 'default-stream');
		vi.stubEnv('PLUGIN_POSTMARK_TOKEN__EU', 'eu-token');
	});

	it('hands the DEFAULT instance the unsuffixed values, keyed by base name', async () => {
		const send = vi.fn(async (_params: unknown, _extras: unknown, _config: unknown) => ({
			success: true as const,
			id: 'x',
		}));
		const provider = createHostedSendProvider(
			KIND,
			[],
			{ parseExtras: () => undefined, send },
			CONFIG_SPEC
		);

		await provider.sendEmail(transportRecord(null), params);

		expect(send.mock.calls[0]?.[2]).toEqual({
			instanceKey: null,
			env: { PLUGIN_POSTMARK_TOKEN: 'default-token', PLUGIN_POSTMARK_STREAM: 'default-stream' },
		});
	});

	it('hands a NAMED instance its own suffixed values under the same base names', async () => {
		// The whole point of the piece: two transport ids of one plugin kind, two
		// credential sets. A module written against `env.PLUGIN_POSTMARK_TOKEN` gets
		// the EU token here without knowing an instance exists.
		const send = vi.fn(async (_params: unknown, _extras: unknown, _config: unknown) => ({
			success: true as const,
			id: 'x',
		}));
		const provider = createHostedSendProvider(
			KIND,
			[],
			{ parseExtras: () => undefined, send },
			CONFIG_SPEC
		);

		await provider.sendEmail(transportRecord('eu'), params);

		expect(send.mock.calls[0]?.[2]).toEqual({
			instanceKey: 'eu',
			// `PLUGIN_POSTMARK_STREAM__EU` is unset, and an OPTIONAL variable is
			// simply absent rather than inherited from the default instance — the
			// silent credential borrow the whole transport resolver exists to prevent.
			env: { PLUGIN_POSTMARK_TOKEN: 'eu-token' },
		});
	});

	it('fails the attempt CLOSED when a required variable is missing, without calling the module', async () => {
		const send = vi.fn(async (_params: unknown, _extras: unknown, _config: unknown) => ({
			success: true as const,
			id: 'x',
		}));
		const provider = createHostedSendProvider(
			KIND,
			[],
			{ parseExtras: () => undefined, send },
			CONFIG_SPEC
		);

		await expect(provider.sendEmail(transportRecord('nordics'), params)).resolves.toEqual({
			success: false,
			errorCode: EmailErrorCode.AUTH_FAILED,
			errorMessage: 'Bundled send transport failed',
		});
		expect(send).not.toHaveBeenCalled();
	});

	it('hands over nothing the transport did not declare', async () => {
		vi.stubEnv('MTA_API_KEY', 'the-deployments-own-mta-key');
		vi.stubEnv('PLUGIN_POSTMARK_UNDECLARED', 'not-yours');
		const send = vi.fn(async (_params: unknown, _extras: unknown, _config: unknown) => ({
			success: true as const,
			id: 'x',
		}));
		const provider = createHostedSendProvider(
			KIND,
			[],
			{ parseExtras: () => undefined, send },
			CONFIG_SPEC
		);

		await provider.sendEmail(transportRecord(null), params);

		const config = send.mock.calls[0]?.[2] as unknown as { env: Record<string, string> };
		expect(Object.keys(config.env).sort()).toEqual([
			'PLUGIN_POSTMARK_STREAM',
			'PLUGIN_POSTMARK_TOKEN',
		]);
		expect(JSON.stringify(config)).not.toContain('the-deployments-own-mta-key');
	});

	it('refuses a declared name outside the plugin namespace at the READ, not just at compose', async () => {
		// Three enforcements of one rule, and this is the innermost: even if a
		// hand-edited artifact got a host variable past the manifest validator AND
		// past the catalog's composition guard, the reader answers `undefined` for a
		// name outside the namespace — so the send fails closed instead of the
		// module being handed the value.
		vi.stubEnv('MTA_API_KEY', 'the-deployments-own-mta-key');
		const send = vi.fn(async (_params: unknown, _extras: unknown, _config: unknown) => ({
			success: true as const,
			id: 'x',
		}));
		const provider = createHostedSendProvider(
			KIND,
			[],
			{ parseExtras: () => undefined, send },
			{ instanceEnvVars: ['MTA_API_KEY'], requiredEnvVars: ['MTA_API_KEY'] }
		);

		await expect(provider.sendEmail(transportRecord(null), params)).resolves.toMatchObject({
			success: false,
			errorCode: EmailErrorCode.AUTH_FAILED,
		});
		expect(send).not.toHaveBeenCalled();
	});

	it('gives a transport that declares no configuration the empty record', async () => {
		const send = vi.fn(async (_params: unknown, _extras: unknown, _config: unknown) => ({
			success: true as const,
			id: 'x',
		}));
		const provider = createHostedSendProvider(KIND, [], { parseExtras: () => undefined, send });

		await provider.sendEmail(transportRecord(null), params);

		expect(send.mock.calls[0]?.[2]).toEqual({ instanceKey: null, env: {} });
	});
});

describe('the extras builders, at parity with a core adapter', () => {
	it('offers the routing facts and withholds the governance handles', () => {
		const buildDispatchExtras = vi.fn((context: unknown) => context);
		const provider = createHostedSendProvider(KIND, [], {
			parseExtras: (input: unknown) => input,
			send: async () => ({ success: true as const, id: 'x' }),
			buildDispatchExtras,
		});

		const extras = provider.buildDispatchExtras?.(facts());

		expect(extras).toEqual({
			idempotencyKey: 'send-1',
			messageType: 'campaign',
			deliveryDomain: 'production',
			ipPool: 'transactional',
			warmupOverflowEnabled: true,
			engagementScore: 42,
			// Renamed on the way across, because a plugin's version of this fact is
			// "the envelope sender to stamp", not "the relay host the router resolved".
			returnPathHost: 'bounce.example.com',
		});
		// The work-attempt id, the re-entry snapshot handle and the routing lease are
		// capability handles the backend authenticates ITSELF with. No transport has
		// a send to make with them, so they stop at this boundary.
		const seen = JSON.stringify(buildDispatchExtras.mock.calls[0]?.[0]);
		expect(seen).not.toContain('reentry-token-nobody-else-may-hold');
		expect(seen).not.toContain('lease-nobody-else-may-hold');
		expect(seen).not.toContain('attempt-1');
		expect(seen).not.toContain('org-1');
	});

	it('omits an absent fact rather than passing a null through', () => {
		const provider = createHostedSendProvider(KIND, [], {
			parseExtras: (input: unknown) => input,
			send: async () => ({ success: true as const, id: 'x' }),
			buildDispatchExtras: (context: unknown) => context,
		});

		const extras = provider.buildDispatchExtras?.({
			...facts(),
			ipPool: undefined,
			engagementScore: undefined,
			relayReturnPathHost: undefined,
			warmupOverflowEnabled: undefined,
		}) as Record<string, unknown>;

		expect(Object.keys(extras).sort()).toEqual(['deliveryDomain', 'idempotencyKey', 'messageType']);
	});

	it('carries the system-mail key, and only when the caller had one', () => {
		const provider = createHostedSendProvider(KIND, [], {
			parseExtras: (input: unknown) => input,
			send: async () => ({ success: true as const, id: 'x' }),
			buildSystemMailExtras: (context: unknown) => context,
		});

		expect(provider.buildSystemMailExtras?.({ idempotencyKey: 'reset-1' })).toEqual({
			idempotencyKey: 'reset-1',
		});
		expect(provider.buildSystemMailExtras?.({})).toEqual({});
	});

	it('declines for a module that exports no builder — the boundary, not a tier test', () => {
		const provider = createHostedSendProvider(KIND, [], {
			parseExtras: (input: unknown) => input,
			send: async () => ({ success: true as const, id: 'x' }),
		});

		expect(provider.buildDispatchExtras).toBeUndefined();
		expect(provider.buildSystemMailExtras).toBeUndefined();
	});

	it('swallows a THROWING builder rather than taking the send path down with it', () => {
		// This runs inside the governed boundary, before any dispatch bookkeeping.
		// A knob that is optional by construction must not be able to fail a send.
		const provider = createHostedSendProvider(KIND, [], {
			parseExtras: (input: unknown) => input,
			send: async () => ({ success: true as const, id: 'x' }),
			buildDispatchExtras: () => {
				throw new Error('secret plugin detail');
			},
		});

		expect(provider.buildDispatchExtras?.(facts())).toBeUndefined();
	});

	it('re-parses its own builder output at the same boundary a host value crosses', async () => {
		const parseExtras = vi.fn(() => {
			throw new TypeError('refused');
		});
		const provider = createHostedSendProvider(KIND, [], {
			parseExtras,
			send: async () => ({ success: true as const, id: 'x' }),
		});

		await expect(
			provider.sendEmail(transportRecord(null), params, { forged: true })
		).resolves.toMatchObject({ success: false, errorCode: EmailErrorCode.UNKNOWN });
		expect(parseExtras).toHaveBeenCalledWith({ forged: true });
	});

	it('rejects a builder that is not callable, at module load', () => {
		expect(() =>
			createHostedSendProvider(KIND, [], {
				parseExtras: (input: unknown) => input,
				send: async () => ({ success: true as const, id: 'x' }),
				buildDispatchExtras: 'not a function',
			})
		).toThrow(TypeError);
	});
});

/**
 * THE REGISTRY-LEVEL PAIR. Both halves of the dedup promise are checked where
 * both are visible: the catalog declares it, the module carries it.
 */
describe('registering a hosted transport that claims idempotency-key dedup', () => {
	const CATALOG = '../../../plugins/sendTransportCatalog.generated';
	const MODULES = '../../../plugins/sendTransportModules.generated';
	const PLUGINS = '../../../plugins/plugins.generated';

	function catalogEntry(overrides: Record<string, unknown> = {}) {
		return Object.freeze({
			kind: KIND,
			pluginId: 'mail-pack',
			localId: 'postmark',
			label: 'Postmark',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'send:transport',
			deduplicatesOnIdempotencyKey: true,
			...overrides,
		});
	}

	async function composeRegistryWith(module: Record<string, unknown>): Promise<unknown> {
		vi.resetModules();
		vi.doMock(CATALOG, () => ({ BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: [catalogEntry()] }));
		vi.doMock(MODULES, () => ({
			BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES: [{ kind: KIND, pluginId: 'mail-pack', module }],
		}));
		vi.doMock(PLUGINS, () => ({
			bundledPluginComposition: [
				{
					packageName: '@acme/mail-pack',
					manifest: {
						id: 'mail-pack',
						version: '1.0.0',
						capabilities: ['send:transport'],
						flag: { default: false, requiredEnvVars: [] },
					},
				},
			],
		}));
		return import('../index');
	}

	afterEach(() => {
		for (const specifier of [CATALOG, MODULES, PLUGINS]) vi.doUnmock(specifier);
		vi.resetModules();
	});

	it('refuses the registration when the module cannot carry the key', async () => {
		await expect(
			composeRegistryWith({
				parseExtras: (input: unknown) => input,
				send: async () => ({ success: true, id: 'x' }),
			})
		).rejects.toThrow(/deduplicatesOnIdempotencyKey: true[\s\S]*buildSystemMailExtras/);
	});

	it('registers it when the module does, and answers through the module', async () => {
		const registry = (await composeRegistryWith({
			parseExtras: (input: unknown) => input,
			send: async () => ({ success: true, id: 'x' }),
			buildSystemMailExtras: (context: { idempotencyKey?: string }) => ({
				dedupToken: context.idempotencyKey,
			}),
		})) as {
			buildSystemMailExtrasFor: (kind: string, input: { idempotencyKey?: string }) => unknown;
			buildDispatchExtrasFor: (kind: string, input: DispatchExtrasInput) => unknown;
		};

		expect(registry.buildSystemMailExtrasFor(KIND, { idempotencyKey: 'reset-1' })).toEqual({
			dedupToken: 'reset-1',
		});
		// The governed boundary asks the same module the same way; this one declares
		// no dispatch builder, so it gets the empty extras that path always sent.
		expect(registry.buildDispatchExtrasFor(KIND, facts())).toEqual({});
	});
});
