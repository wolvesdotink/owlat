/**
 * The feedback webhook a send transport may declare (the seams plan's D6,
 * wired by P2.2) — the MANIFEST half.
 *
 * The route this descriptor feeds is unauthenticated and internet-facing by
 * design, so the validator is the first of the piece's fail-closed gates and the
 * only one that runs before a deployment ever starts: a webhook whose
 * authenticity nobody checks must not compose at all. These cases pin that, plus
 * the two structural rules the route surface depends on — one webhook per plugin
 * (the URL is keyed by plugin id, so a second one is unaddressable) and a
 * signature contract that carries replay provisions (an HMAC over the body alone
 * verifies a captured request forever).
 */

import { describe, expect, it } from 'vitest';
import {
	PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS,
	parsePluginManifest,
	pluginContributionModules,
	validatePluginManifest,
} from '../index';

function signature(overrides: Record<string, unknown> = {}) {
	return {
		header: 'x-postmark-signature',
		algorithm: 'hmac-sha256',
		encoding: 'hex',
		secretEnvVar: 'PLUGIN_POSTMARK_WEBHOOK_SECRET',
		replay: { timestampHeader: 'x-postmark-timestamp', toleranceSeconds: 300 },
		...overrides,
	};
}

function webhook(overrides: Record<string, unknown> = {}) {
	return {
		module: { exportPath: './webhooks/postmark' },
		signature: signature(),
		...overrides,
	};
}

function transport(overrides: Record<string, unknown> = {}) {
	return {
		id: 'postmark',
		label: 'Postmark',
		module: { exportPath: './transports/postmark' },
		retryDelays: [1_000, 5_000],
		...overrides,
	};
}

function manifest(transports: readonly unknown[]) {
	return {
		id: 'mail-pack',
		version: '1.0.0',
		capabilities: ['send:transport'],
		flag: { default: false, requiredEnvVars: ['POSTMARK_TOKEN'] },
		contributes: { sendTransports: transports },
	};
}

function issuePaths(value: unknown): string[] {
	const result = validatePluginManifest(value);
	expect(result.ok).toBe(false);
	return result.ok ? [] : result.issues.map((issue) => issue.path);
}

const WEBHOOK_PATH = '$.contributes.sendTransports[0].webhook';

describe('a declared feedback webhook', () => {
	it('composes, and is frozen all the way down', () => {
		const parsed = parsePluginManifest(manifest([transport({ webhook: webhook() })]));
		const declared = parsed.contributes?.sendTransports?.[0]?.webhook;

		expect(declared).toEqual(webhook());
		// Every nested descriptor is snapshotted, not aliased: the manifest object
		// a package exports stays mutable, and these are the fields that decide
		// whether an internet-facing request is authentic. An aliased `signature`
		// would be a time-of-check/time-of-use gap on exactly those fields.
		expect(Object.isFrozen(declared)).toBe(true);
		expect(Object.isFrozen(declared?.module)).toBe(true);
		expect(Object.isFrozen(declared?.signature)).toBe(true);
		expect(Object.isFrozen(declared?.signature.replay)).toBe(true);
	});

	it('is optional — a transport without one still composes', () => {
		const parsed = parsePluginManifest(manifest([transport()]));
		expect(parsed.contributes?.sendTransports?.[0]?.webhook).toBeUndefined();
	});

	it('is provenance-visible to codegen as a second executable half', () => {
		// Codegen imports this export path into generated Convex code, so it must
		// be resolved and verified like any other module. `pluginContributionModules`
		// is the ONE structural walk that decides what gets verified; a webhook it
		// cannot see is a webhook imported unverified.
		const parsed = parsePluginManifest(manifest([transport({ webhook: webhook() })]));
		expect(pluginContributionModules(parsed)).toEqual([
			{ bucket: 'sendTransports', id: 'postmark', exportPath: './transports/postmark' },
			{
				bucket: 'sendTransports',
				id: 'postmark',
				exportPath: './webhooks/postmark',
				role: 'webhook',
			},
		]);
	});
});

describe('a webhook without a usable verifier does not compose', () => {
	it('rejects a webhook with no signature contract at all', () => {
		// THE piece's floor. An unverified inbound adapter on an unauthenticated
		// route is an open write path into the delivery record.
		const { signature: _dropped, ...unverified } = webhook();
		expect(issuePaths(manifest([transport({ webhook: unverified })]))).toContain(
			`${WEBHOOK_PATH}.signature`
		);
	});

	it.each([
		['no replay provisions', (({ replay: _r, ...rest }) => rest)(signature()), '.replay'],
		[
			'an unbounded tolerance',
			signature({
				replay: {
					timestampHeader: 'x-t',
					toleranceSeconds: PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS + 1,
				},
			}),
			'.replay.toleranceSeconds',
		],
		[
			'a zero tolerance',
			signature({ replay: { timestampHeader: 'x-t', toleranceSeconds: 0 } }),
			'.replay.toleranceSeconds',
		],
		[
			'no timestamp header',
			signature({ replay: { toleranceSeconds: 300 } }),
			'.replay.timestampHeader',
		],
		[
			'an upper-case timestamp header',
			signature({ replay: { timestampHeader: 'X-Time', toleranceSeconds: 300 } }),
			'.replay.timestampHeader',
		],
		['an unknown algorithm', signature({ algorithm: 'md5' }), '.algorithm'],
		['an unknown encoding', signature({ encoding: 'base32' }), '.encoding'],
		['an upper-case signature header', signature({ header: 'X-Sig' }), '.header'],
		[
			'a host secret outside the plugin namespace',
			signature({ secretEnvVar: 'DATABASE_URL' }),
			'.secretEnvVar',
		],
		['an unknown signature field', signature({ skipVerification: true }), '.skipVerification'],
	] as const)('rejects a signature with %s', (_label, value, suffix) => {
		expect(issuePaths(manifest([transport({ webhook: webhook({ signature: value }) })]))).toContain(
			`${WEBHOOK_PATH}.signature${suffix}`
		);
	});

	it.each([
		['a missing module', (({ module: _m, ...rest }) => rest)(webhook()), '.module'],
		[
			'a traversing export path',
			webhook({ module: { exportPath: '../../host/secrets' } }),
			'.module.exportPath',
		],
		['an unknown field', webhook({ verify: false }), '.verify'],
		['a non-boolean storeRawPayload', webhook({ storeRawPayload: 'yes' }), '.storeRawPayload'],
		['a non-object body', 'https://attacker.test', ''],
	] as const)('rejects a webhook with %s', (_label, value, suffix) => {
		expect(issuePaths(manifest([transport({ webhook: value })]))).toContain(
			`${WEBHOOK_PATH}${suffix}`
		);
	});

	it('rejects a webhook accessor without evaluating it', () => {
		let reads = 0;
		const declared = transport();
		Object.defineProperty(declared, 'webhook', {
			enumerable: true,
			get() {
				reads += 1;
				return webhook();
			},
		});
		expect(issuePaths(manifest([declared]))).toContain(WEBHOOK_PATH);
		expect(reads).toBe(0);
	});
});

describe('one plugin, one webhook route', () => {
	it('rejects a second transport that also declares one', () => {
		// The route is `/webhooks/plugin/<pluginId>`: a second webhook has no
		// address, so it would silently never receive an event. Refused at manifest
		// time rather than resolved by an arbitrary tie-break at dispatch time.
		expect(
			issuePaths(
				manifest([
					transport({ webhook: webhook() }),
					transport({ id: 'postmark-eu', webhook: webhook() }),
				])
			)
		).toContain('$.contributes.sendTransports[1].webhook');
	});

	it('counts a MALFORMED second declaration too', () => {
		// Otherwise dropping a required field would be the way to smuggle a second
		// webhook past the count — the manifest would be rejected today and accepted
		// the moment the author "fixed" the first complaint.
		const paths = issuePaths(
			manifest([transport({ webhook: webhook() }), transport({ id: 'second', webhook: {} })])
		);
		expect(paths).toContain('$.contributes.sendTransports[1].webhook');
	});

	it('accepts a second transport that declares none', () => {
		const result = validatePluginManifest(
			manifest([transport({ webhook: webhook() }), transport({ id: 'postmark-eu' })])
		);
		expect(result.ok).toBe(true);
	});
});
