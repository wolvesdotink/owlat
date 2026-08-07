/**
 * The sending-domain identity a send transport may declare (the seams plan's
 * D5, wired by P3.2) — the MANIFEST half.
 *
 * Declaring one is the catalog's `domainVerification: 'api'` for this kind, and
 * that word is a PROMISE three separate host paths read: the routing gate that
 * decides whether a customer's From domain may be handed to this relay at all,
 * the backfill that writes the identity that proof is read from, and the
 * alignment pre-flight that holds the ramp at s=0 until a second arm can be
 * described. So the validator's job here is to refuse a declaration whose other
 * half cannot exist — a module codegen could not resolve, and (the rule an
 * author will not expect) an identity on a transport that declares no
 * configuration of its own, whose module would therefore be handed an empty
 * environment and call the provider unauthenticated.
 */

import { describe, expect, it } from 'vitest';
import { parsePluginManifest, pluginContributionModules, validatePluginManifest } from '../index';

function domainIdentity(overrides: Record<string, unknown> = {}) {
	return {
		module: { exportPath: './domains/postmark' },
		...overrides,
	};
}

function transport(overrides: Record<string, unknown> = {}) {
	return {
		id: 'postmark',
		label: 'Postmark',
		module: { exportPath: './transports/postmark' },
		retryDelays: [1_000, 5_000],
		requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'],
		...overrides,
	};
}

function manifest(transports: readonly unknown[]) {
	return {
		id: 'mail-pack',
		version: '1.0.0',
		capabilities: ['send:transport'],
		flag: { default: false, requiredEnvVars: ['POSTMARK_PACK_ENABLED'] },
		contributes: { sendTransports: transports },
	};
}

function issuePaths(value: unknown): string[] {
	const result = validatePluginManifest(value);
	expect(result.ok).toBe(false);
	return result.ok ? [] : result.issues.map((issue) => issue.path);
}

const IDENTITY_PATH = '$.contributes.sendTransports[0].domainIdentity';

describe('a declared sending-domain identity', () => {
	it('composes, and is frozen all the way down', () => {
		const parsed = parsePluginManifest(manifest([transport({ domainIdentity: domainIdentity() })]));
		const declared = parsed.contributes?.sendTransports?.[0]?.domainIdentity;

		expect(declared).toEqual(domainIdentity());
		// The nested `module` is what codegen provenance-verifies and imports into
		// generated Convex code; a live inner object could pass validation and then
		// name a different export path.
		expect(Object.isFrozen(declared)).toBe(true);
		expect(Object.isFrozen(declared?.module)).toBe(true);
	});

	it('is discovered as an executable half under its own role', () => {
		// Codegen imports it exactly like the send and feedback halves, so it has to
		// be provenance-verified exactly like them — which only happens if the
		// structural walk finds it.
		const parsed = parsePluginManifest(manifest([transport({ domainIdentity: domainIdentity() })]));

		expect(pluginContributionModules(parsed)).toEqual([
			{ bucket: 'sendTransports', id: 'postmark', exportPath: './transports/postmark' },
			{
				bucket: 'sendTransports',
				id: 'postmark',
				exportPath: './domains/postmark',
				role: 'domainIdentity',
			},
		]);
	});

	it('is optional — a transport without one still composes', () => {
		const parsed = parsePluginManifest(manifest([transport()]));

		expect(parsed.contributes?.sendTransports?.[0]?.domainIdentity).toBeUndefined();
	});
});

describe('a malformed sending-domain identity', () => {
	it('refuses a non-object declaration', () => {
		expect(issuePaths(manifest([transport({ domainIdentity: 'yes' })]))).toContain(IDENTITY_PATH);
	});

	it('refuses a missing module', () => {
		expect(issuePaths(manifest([transport({ domainIdentity: {} })]))).toContain(
			`${IDENTITY_PATH}.module`
		);
	});

	it('refuses an export path codegen could not safely resolve', () => {
		expect(
			issuePaths(
				manifest([
					transport({ domainIdentity: domainIdentity({ module: { exportPath: '../..' } }) }),
				])
			)
		).toContain(`${IDENTITY_PATH}.module.exportPath`);
	});

	it('refuses an unknown field beside the module', () => {
		// The descriptor is deliberately one field. A `maxProofAgeMs` or a
		// `dkimSelectors` here would be a manifest declaring something the host
		// decides — and an unknown-field error is how an author finds that out.
		expect(
			issuePaths(manifest([transport({ domainIdentity: domainIdentity({ maxProofAgeMs: 1 }) })]))
		).toContain(`${IDENTITY_PATH}.maxProofAgeMs`);
	});
});

describe('the join to the transport’s own configuration', () => {
	it('refuses an identity on a transport that declares no configuration', () => {
		// The module is handed THIS TRANSPORT's variables and nothing else — the
		// plugin's flag variables are the plugin's. With no declaration the module
		// receives `{}` and every provider call it makes is unauthenticated, which
		// surfaces only as a relay that reports every domain unverified forever.
		const transports = [
			{
				id: 'postmark',
				label: 'Postmark',
				module: { exportPath: './transports/postmark' },
				retryDelays: [1_000],
				domainIdentity: domainIdentity(),
			},
		];

		expect(issuePaths(manifest(transports))).toContain(IDENTITY_PATH);
	});

	it('accepts one beside a declared required variable', () => {
		const result = validatePluginManifest(
			manifest([transport({ domainIdentity: domainIdentity() })])
		);

		expect(result.ok).toBe(true);
	});

	it('is refused when the only declared variables are optional', () => {
		// `optionalEnvVars` without a required one is already refused on its own; the
		// identity rule is stated against the REQUIRED set, so this reports both
		// rather than silently accepting an identity whose configuration a deployment
		// may skip.
		const paths = issuePaths(
			manifest([
				{
					id: 'postmark',
					label: 'Postmark',
					module: { exportPath: './transports/postmark' },
					retryDelays: [1_000],
					optionalEnvVars: ['PLUGIN_POSTMARK_REGION'],
					domainIdentity: domainIdentity(),
				},
			])
		);

		expect(paths).toContain(IDENTITY_PATH);
		expect(paths).toContain('$.contributes.sendTransports[0].optionalEnvVars');
	});
});
