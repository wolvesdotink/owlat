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
 *     not one outside the `PLUGIN_` namespace, never the governance handles on
 *     the governed dispatch input — and not the return-path host the routing pass
 *     resolved for a DIFFERENT relay kind, which is authorised against that
 *     relay's published SPF and belongs to nobody else.
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

	it("withholds the ROUTED RELAY's return-path host, which is not this kind's", () => {
		// The input carries one whenever the route had a probe-decided relay among
		// its candidates — including on a send this plugin kind won. It is resolved
		// for THAT relay: `relayReturnPathHostFor` only returns a host whose published
		// SPF authorises that relay's sending IPs, so offering it here would invite a
		// stamp that fails SPF on the bounce domain of every message it stamped. And
		// the VERP local part that makes a bounce attributable is signed by the host
		// anyway, so a bare host is not a return path a module could use. Hence
		// `supportsCustomReturnPath` has only `no` at this tier.
		const buildDispatchExtras = vi.fn((context: unknown) => context);
		const provider = createHostedSendProvider(KIND, [], {
			parseExtras: (input: unknown) => input,
			send: async () => ({ success: true as const, id: 'x' }),
			buildDispatchExtras,
		});

		provider.buildDispatchExtras?.(facts());

		expect(JSON.stringify(buildDispatchExtras.mock.calls[0]?.[0])).not.toContain(
			'bounce.example.com'
		);
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

	it('swallows a THROWING dispatch builder, but says so against the kind', () => {
		// This runs inside the governed boundary, before any dispatch bookkeeping.
		// A knob that is optional by construction must not be able to fail a send —
		// and it must not be invisible either, or a builder that always throws is
		// indistinguishable from one that works.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const provider = createHostedSendProvider(KIND, [], {
			parseExtras: (input: unknown) => input,
			send: async () => ({ success: true as const, id: 'x' }),
			buildDispatchExtras: () => {
				throw new Error('secret plugin detail');
			},
		});

		expect(provider.buildDispatchExtras?.(facts())).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		const logged = String(warn.mock.calls[0]?.[0]);
		expect(logged).toContain(KIND);
		// Outcome only. The thrown text is untrusted and may quote configuration.
		expect(logged).not.toContain('secret plugin detail');
		warn.mockRestore();
	});

	it('lets a THROWING SYSTEM-MAIL builder fail the attempt instead', () => {
		// The asymmetry IS the dedup promise. Empty extras here are
		// indistinguishable from extras that carried the key, while
		// `systemMailRetryDisposition` keeps reading the catalog's
		// `deduplicatesOnIdempotencyKey` — so swallowing this would report an
		// ambiguous password reset `safe_to_retry` with no key ever sent, and the
		// "retry" is a second mail to a real person. `systemMail.ts` calls this
		// inside the try that wraps the attempt, so a throw is a failed attempt
		// before any mail goes out.
		const provider = createHostedSendProvider(KIND, [], {
			parseExtras: (input: unknown) => input,
			send: async () => ({ success: true as const, id: 'x' }),
			buildSystemMailExtras: () => {
				throw new Error('bad key shape');
			},
		});

		expect(() => provider.buildSystemMailExtras?.({ idempotencyKey: 'reset-1' })).toThrow(
			'bad key shape'
		);
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
 * THE REGISTRY-LEVEL PAIR. Both halves of a promise are checked where both are
 * visible: the catalog declares it, the module carries it.
 *
 * ONE declaration is a pair of this shape, and it cannot be checked at the
 * catalog alone: `deduplicatesOnIdempotencyKey` needs `buildSystemMailExtras` to
 * carry the key. `supportsCustomReturnPath` deliberately is NOT one — no value of
 * it above `no` may reach a bundled entry at all, because the wire it would need
 * is an envelope sender the HOST signs, so it is refused one layer earlier on the
 * artifact itself (`pluginCustodyGuard.test.ts`).
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

	async function composeRegistryWith(
		module: Record<string, unknown>,
		entryOverrides: Record<string, unknown> = {}
	): Promise<unknown> {
		vi.resetModules();
		vi.doMock(CATALOG, () => ({
			BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: [catalogEntry(entryOverrides)],
		}));
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

	it('sends whoever hits the boot failure to a file that declares what it names', async () => {
		// A BOOT FAILURE IS A ONE-SHOT EXPLANATION — the same rule
		// `pluginCustodyGuard.test.ts` holds the catalog's throws to, applied to the
		// registry's. Whoever hits one is reading the string, not the codebase, so a
		// pointer at a renamed file or a moved symbol costs them the hunt the message
		// exists to save.
		//
		// ONE MESSAGE, asserted once. This registry has exactly one guard with a
		// pointer in it; the return-path guard that used to sit beside it moved to
		// the catalog, where the artifact is refused before a module is ever loaded.
		// A loop over one case would only invite the failure mode the sibling file
		// documents — two iterations quietly asserting the same message.
		const message = await composeRegistryWith({
			parseExtras: (input: unknown) => input,
			send: async () => ({ success: true, id: 'x' }),
		}).then(
			() => '',
			(error: unknown) => (error as Error).message
		);

		const { existsSync, readFileSync } = await import('node:fs');
		const { dirname, resolve } = await import('node:path');
		const { fileURLToPath } = await import('node:url');
		const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
		const [, symbol, path] = /See (\w+) in (\S+\.ts)/.exec(message) ?? [];
		expect({ message, symbol, path }).toMatchObject({
			symbol: expect.any(String),
			path: expect.any(String),
		});
		const onDisk = [resolve(repoRoot, path!), resolve(repoRoot, 'apps/api/convex', path!)].find(
			(candidate) => existsSync(candidate)
		);
		expect({ path, onDisk }).toMatchObject({ onDisk: expect.any(String) });
		expect(readFileSync(onDisk!, 'utf8')).toContain(symbol!);
	});
});
