/**
 * The plugin domain-identity registry refuses to LOAD when its two generated
 * halves disagree (the seams plan's P3.2).
 *
 * Every other check in this piece runs per call. This one runs once, at module
 * load, and it is the only one that can still be made to run before a deployment
 * serves anything — which is why the failures it catches are the ones that must
 * never become a runtime surprise: a catalog entry whose module was never emitted
 * (a relay the routing gate believes can prove domains and which nothing can be
 * asked of), a module for a transport the send catalog does not hold or another
 * plugin owns (a proof about a kind no route can select), configuration outside
 * the `PLUGIN_` namespace (this deployment's own credentials handed to
 * third-party code), and an entry with no required variable at all (a module
 * called with an empty environment, whose every provider call is
 * unauthenticated).
 *
 * Each case swaps the generated modules and re-imports, so what is under test is
 * the guard in `sendTransportDomainIdentityCatalog.ts`, not a copy of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CATALOG = '../sendTransportDomainIdentityCatalog.generated';
const MODULES = '../sendTransportDomainIdentityModules.generated';
const SEND_CATALOG = '../sendTransportCatalog.generated';

const KIND = 'plugin.mail-pack.postmark';

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

function identityEntry(kind: string, pluginId: string, overrides: Record<string, unknown> = {}) {
	return Object.freeze({
		kind,
		pluginId,
		localId: kind.split('.').pop(),
		label: 'Relay',
		instanceEnvVars: Object.freeze(['PLUGIN_RELAY_TOKEN']),
		requiredEnvVars: Object.freeze(['PLUGIN_RELAY_TOKEN']),
		requiredCapability: 'send:transport',
		...overrides,
	});
}

function moduleEntry(
	kind: string,
	pluginId: string,
	module: unknown = { registerDomain: async () => ({}), checkDomain: async () => ({}) }
) {
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
		BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG: Object.freeze(composition.catalog),
	}));
	vi.doMock(MODULES, () => ({
		BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_MODULES: Object.freeze(composition.modules),
	}));
	return import('../sendTransportDomainIdentityCatalog');
}

const WELL_FORMED: Composition = {
	send: [sendEntry(KIND, 'mail-pack')],
	catalog: [identityEntry(KIND, 'mail-pack')],
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
	it('resolves the surface by transport kind and nothing else by anything else', async () => {
		const registry = await load(WELL_FORMED);
		const resolved = registry.pluginSendTransportDomainIdentityFor(KIND);

		expect(resolved?.definition.label).toBe('Relay');
		expect(typeof resolved?.module.registerDomain).toBe('function');
		expect(typeof resolved?.module.checkDomain).toBe('function');
		// Keyed by KIND, not by plugin id — an identity belongs to the transport
		// whose account it was registered under, and the prototype keys a plain
		// object lookup would have answered resolve to nothing.
		for (const absent of ['mail-pack', 'plugin.other.relay', '__proto__', 'constructor', '']) {
			expect(registry.pluginSendTransportDomainIdentityFor(absent)).toBeUndefined();
		}
	});

	it('exposes the kinds and the definition the authorization seam resolves', async () => {
		const registry = await load(WELL_FORMED);

		expect(registry.pluginSendTransportDomainIdentityKinds()).toEqual([KIND]);
		expect(registry.pluginSendTransportDomainIdentityDefinition(KIND)?.pluginId).toBe('mail-pack');
		expect(registry.pluginSendTransportDomainIdentityDefinition('nope')).toBeUndefined();
	});

	it('holds two transports of one plugin, each with its own identity', async () => {
		// Unlike the feedback webhook, which is one per plugin because its route
		// surface is keyed by plugin id: two transports are two provider accounts.
		const second = 'plugin.mail-pack.relay-two';
		const registry = await load({
			send: [sendEntry(KIND, 'mail-pack'), sendEntry(second, 'mail-pack')],
			catalog: [identityEntry(KIND, 'mail-pack'), identityEntry(second, 'mail-pack')],
			modules: [moduleEntry(KIND, 'mail-pack'), moduleEntry(second, 'mail-pack')],
		});

		expect(registry.pluginSendTransportDomainIdentityKinds()).toEqual([KIND, second]);
	});
});

describe('a composition the host refuses to serve', () => {
	it.each([
		[
			'a catalog entry whose module was never emitted',
			{ ...WELL_FORMED, modules: [] },
			/missing a module/,
		],
		[
			'a module with no catalog entry',
			{ ...WELL_FORMED, catalog: [] },
			/Invalid bundled send transport domain identity registry/,
		],
		[
			'a module claimed by another plugin',
			{ ...WELL_FORMED, modules: [moduleEntry(KIND, 'other-pack')] },
			/Invalid bundled send transport domain identity registry/,
		],
		[
			'two identities under one kind',
			{
				...WELL_FORMED,
				catalog: [identityEntry(KIND, 'mail-pack')],
				modules: [moduleEntry(KIND, 'mail-pack'), moduleEntry(KIND, 'mail-pack')],
			},
			/Invalid bundled send transport domain identity registry/,
		],
		[
			'an identity for a transport the send catalog does not hold',
			{ ...WELL_FORMED, send: [] },
			/unknown transport kind/,
		],
		[
			'an identity for a transport another plugin owns',
			{ ...WELL_FORMED, send: [sendEntry(KIND, 'other-pack')] },
			/not owned by its transport/,
		],
		[
			'configuration outside the PLUGIN_ namespace',
			{
				...WELL_FORMED,
				catalog: [
					identityEntry(KIND, 'mail-pack', {
						instanceEnvVars: ['AWS_SECRET_ACCESS_KEY'],
						requiredEnvVars: ['AWS_SECRET_ACCESS_KEY'],
					}),
				],
			},
			/outside the PLUGIN_ namespace/,
		],
		[
			'an entry with no required configuration at all',
			{
				...WELL_FORMED,
				catalog: [identityEntry(KIND, 'mail-pack', { instanceEnvVars: [], requiredEnvVars: [] })],
			},
			/no required configuration variable/,
		],
		[
			'a required variable the entry never resolves',
			{
				...WELL_FORMED,
				catalog: [
					identityEntry(KIND, 'mail-pack', {
						instanceEnvVars: ['PLUGIN_RELAY_REGION'],
						requiredEnvVars: ['PLUGIN_RELAY_TOKEN'],
					}),
				],
			},
			/never resolves/,
		],
	])('refuses %s', async (_label, composition, message) => {
		await expect(load(composition as Composition)).rejects.toThrow(message);
	});

	it.each([
		['a module missing a call', { registerDomain: async () => ({}) }],
		[
			'a module with an extra key',
			{
				registerDomain: async () => ({}),
				checkDomain: async () => ({}),
				verifySignature: () => true,
			},
		],
		[
			'a module exposing a call as a getter',
			Object.defineProperty({ checkDomain: async () => ({}) }, 'registerDomain', {
				get: () => async () => ({}),
				enumerable: true,
			}),
		],
		[
			'a module with a prototype',
			Object.create({ registerDomain: async () => ({}), checkDomain: async () => ({}) }),
		],
		['a module that is an array', []],
		['a module that is null', null],
	])('refuses %s', async (_label, module) => {
		// The same bar the send and feedback halves set: a generated import that
		// reached the registry with a getter, a prototype or a missing method is a
		// failure that must happen at module load, not one frame inside a scheduled
		// identity call whose only symptom is a domain that never verifies.
		await expect(
			load({ ...WELL_FORMED, modules: [moduleEntry(KIND, 'mail-pack', module)] })
		).rejects.toThrow(/Invalid bundled send transport domain identity module/);
	});
});
