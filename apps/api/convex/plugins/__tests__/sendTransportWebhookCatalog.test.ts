/**
 * The plugin webhook registry refuses to LOAD when its two generated halves
 * disagree (the seams plan's D6/P2.2).
 *
 * Every other check in this piece runs per request. This one runs once, at
 * module load, and it is the only one that can still be made to run before a
 * deployment serves anything — which is why the failures it catches are the ones
 * that must never become a runtime surprise: a catalog entry whose module was
 * never emitted (a route that 500s a retrying provider until it disables the
 * endpoint), a module for a transport the send catalog does not hold or another
 * plugin owns (events attributed to an arm the measurement plane does not have),
 * and two webhooks under one plugin id (the route is keyed by that id, so one of
 * them would silently never be reachable).
 *
 * Each case swaps the generated modules and re-imports, so what is under test is
 * the guard in `sendTransportWebhookCatalog.ts`, not a copy of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CATALOG = '../sendTransportWebhookCatalog.generated';
const MODULES = '../sendTransportWebhookModules.generated';
const SEND_CATALOG = '../sendTransportCatalog.generated';

function signature() {
	return Object.freeze({
		header: 'x-postmark-signature',
		algorithm: 'hmac-sha256',
		encoding: 'hex',
		secretEnvVar: 'PLUGIN_POSTMARK_WEBHOOK_SECRET',
		replay: Object.freeze({ timestampHeader: 'x-postmark-timestamp', toleranceSeconds: 300 }),
	});
}

function sendEntry(kind: string, pluginId: string) {
	return Object.freeze({
		kind,
		pluginId,
		localId: kind.split('.').pop(),
		label: 'Relay',
		retryDelays: Object.freeze([0]),
		requiredEnvVars: Object.freeze([]),
		requiredCapability: 'send:transport',
	});
}

function webhookEntry(kind: string, pluginId: string, overrides: Record<string, unknown> = {}) {
	return Object.freeze({
		kind,
		pluginId,
		localId: kind.split('.').pop(),
		signature: signature(),
		storeRawPayload: false,
		requiredCapability: 'send:transport',
		...overrides,
	});
}

function moduleEntry(kind: string, pluginId: string, module: unknown = { parseEvents: () => [] }) {
	return Object.freeze({ kind, pluginId, module });
}

interface Composition {
	readonly send: readonly unknown[];
	readonly catalog: readonly unknown[];
	readonly modules: readonly unknown[];
}

async function load(composition: Composition) {
	vi.resetModules();
	vi.doMock(SEND_CATALOG, () => ({
		BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze(composition.send),
	}));
	vi.doMock(CATALOG, () => ({
		BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG: Object.freeze(composition.catalog),
	}));
	vi.doMock(MODULES, () => ({
		BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_MODULES: Object.freeze(composition.modules),
	}));
	return import('../sendTransportWebhookCatalog');
}

const KIND = 'plugin.mail-pack.postmark';
const WELL_FORMED: Composition = {
	send: [sendEntry(KIND, 'mail-pack')],
	catalog: [webhookEntry(KIND, 'mail-pack')],
	modules: [moduleEntry(KIND, 'mail-pack')],
};

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.doUnmock(SEND_CATALOG);
	vi.doUnmock(CATALOG);
	vi.doUnmock(MODULES);
	vi.resetModules();
});

describe('a well-formed composition', () => {
	it('resolves the surface by plugin id and nothing else by anything else', async () => {
		const registry = await load(WELL_FORMED);
		const resolved = registry.pluginSendTransportWebhookFor('mail-pack');

		expect(resolved?.definition.kind).toBe(KIND);
		expect(typeof resolved?.module.parseEvents).toBe('function');
		// The route's 404 arm: an id nobody claims, and the prototype keys a plain
		// object lookup would have answered.
		for (const absent of ['other-pack', '__proto__', 'constructor', 'toString', '']) {
			expect(registry.pluginSendTransportWebhookFor(absent)).toBeUndefined();
		}
	});

	it('exposes the transport definition the authorization seam resolves by kind', async () => {
		const registry = await load(WELL_FORMED);
		expect(registry.pluginSendTransportWebhookDefinition(KIND)?.pluginId).toBe('mail-pack');
		expect(registry.pluginSendTransportWebhookDefinition('ses')).toBeUndefined();
	});
});

describe('a composition that cannot be trusted fails at load', () => {
	it.each([
		[
			'a catalog entry with no module',
			{ ...WELL_FORMED, modules: [] },
			/missing an executable module/,
		],
		[
			'a module with no catalog entry',
			{ ...WELL_FORMED, catalog: [] },
			/Invalid bundled send transport webhook registry/,
		],
		[
			'a module whose owner is not the entry’s',
			{ ...WELL_FORMED, modules: [moduleEntry(KIND, 'other-pack')] },
			/Invalid bundled send transport webhook registry/,
		],
		[
			'a webhook for a transport the send catalog does not hold',
			{ ...WELL_FORMED, send: [] },
			/unknown transport kind/,
		],
		[
			'a webhook whose transport another plugin owns',
			{ ...WELL_FORMED, send: [sendEntry(KIND, 'other-pack')] },
			/not owned by its transport/,
		],
		[
			'two webhooks under one plugin id',
			{
				send: [sendEntry(KIND, 'mail-pack'), sendEntry('plugin.mail-pack.eu', 'mail-pack')],
				catalog: [
					webhookEntry(KIND, 'mail-pack'),
					webhookEntry('plugin.mail-pack.eu', 'mail-pack'),
				],
				modules: [moduleEntry(KIND, 'mail-pack'), moduleEntry('plugin.mail-pack.eu', 'mail-pack')],
			},
			/Invalid bundled send transport webhook registry/,
		],
		[
			'a duplicated kind',
			{
				send: [sendEntry(KIND, 'mail-pack')],
				catalog: [webhookEntry(KIND, 'mail-pack'), webhookEntry(KIND, 'mail-pack')],
				modules: [moduleEntry(KIND, 'mail-pack')],
			},
			/kinds must be unique/,
		],
	] as const)('%s', async (_label, composition, message) => {
		await expect(load(composition)).rejects.toThrow(message);
	});

	it.each([
		['no parseEvents', {}],
		['a non-function parseEvents', { parseEvents: 'nope' }],
		[
			'a getter instead of a data property',
			Object.defineProperty({}, 'parseEvents', { get: () => () => [], enumerable: true }),
		],
		[
			'an extra export the contract does not name',
			{ parseEvents: () => [], verifySignature: () => true },
		],
		[
			'a class instance rather than a plain object',
			new (class {
				parseEvents() {
					return [];
				}
			})(),
		],
		['an array', []],
		['null', null],
	] as const)('refuses a module with %s', async (_label, module) => {
		// A module the type describes but the package does not produce would fail on
		// `parseEvents is not a function` INSIDE a live webhook — one frame after the
		// route resolved, with a provider waiting.
		await expect(
			load({ ...WELL_FORMED, modules: [moduleEntry(KIND, 'mail-pack', module)] })
		).rejects.toThrow(/Invalid bundled send transport webhook module/);
	});
});
