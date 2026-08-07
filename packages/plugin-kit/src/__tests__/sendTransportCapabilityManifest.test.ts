/**
 * P3.1 — CONTRACT PARITY, the manifest half.
 *
 * A bundled send transport may now declare the catalog's own capability
 * vocabulary and the deployment variables its configuration lives in. Two
 * properties are worth a suite of their own, because both are security floors
 * rather than tidiness:
 *
 *  1. THE NAMESPACE. The host RESOLVES a declared variable and hands the VALUE to
 *     the plugin's module, which `flag.requiredEnvVars` never did (it is only
 *     presence-checked). A manifest that could name `MTA_API_KEY` would be handed
 *     this deployment's own MTA credential, so the names are fenced to
 *     `PLUGIN_`-prefixed — the same rule a settings `secret` and a webhook signing
 *     key already live under.
 *  2. THE INSTANCE SUFFIX. A named instance reads `<BASE>__<INSTANCEKEY>`, so a
 *     base name carrying `__` would alias another instance's credential.
 *
 * The capability fields are checked for the values this tier REFUSES as much as
 * for the ones it accepts: `probe` and `idempotency-key` are legal words in the
 * core catalog, and an author who copies them across gets a named issue rather
 * than a silently-defaulted capability.
 */

import { describe, expect, it } from 'vitest';
import { isPluginSendTransportEnvVar, parsePluginManifest, validatePluginManifest } from '../index';

const PATH = '$.contributes.sendTransports[0]';

function transportDefinition(overrides: Record<string, unknown> = {}) {
	return {
		id: 'postmark',
		label: 'Postmark',
		module: { exportPath: './transports/postmark' },
		retryDelays: [1_000, 5_000],
		...overrides,
	};
}

function manifestWith(overrides: Record<string, unknown>) {
	return {
		id: 'mail-pack',
		version: '1.0.0',
		capabilities: ['send:transport'],
		flag: { default: false, requiredEnvVars: ['PLUGIN_MAIL_PACK_TOKEN'] },
		contributes: { sendTransports: [transportDefinition(overrides)] },
	};
}

function issuePaths(value: unknown): string[] {
	const result = validatePluginManifest(value);
	expect(result.ok).toBe(false);
	return result.ok ? [] : result.issues.map((issue) => issue.path);
}

describe('declared configuration variables', () => {
	it('accepts a namespaced required/optional pair and keeps both frozen', () => {
		const parsed = parsePluginManifest(
			manifestWith({
				requiredEnvVars: ['PLUGIN_MAIL_PACK_TOKEN'],
				optionalEnvVars: ['PLUGIN_MAIL_PACK_STREAM'],
			})
		);
		const transport = parsed.contributes?.sendTransports?.[0];

		expect(transport?.requiredEnvVars).toEqual(['PLUGIN_MAIL_PACK_TOKEN']);
		expect(transport?.optionalEnvVars).toEqual(['PLUGIN_MAIL_PACK_STREAM']);
		expect(Object.isFrozen(transport?.requiredEnvVars)).toBe(true);
		expect(Object.isFrozen(transport?.optionalEnvVars)).toBe(true);
	});

	it('composes exactly as before when a transport declares none', () => {
		const parsed = parsePluginManifest(manifestWith({}));
		const transport = parsed.contributes?.sendTransports?.[0];

		expect(transport?.requiredEnvVars).toBeUndefined();
		expect(transport?.optionalEnvVars).toBeUndefined();
	});

	it.each([
		['a host credential outside the plugin namespace', 'MTA_API_KEY'],
		['an AWS credential', 'AWS_SECRET_ACCESS_KEY'],
		['a lowercase name', 'plugin_mail_pack_token'],
		['a name that only starts with the word', 'PLUGINS_TOKEN'],
		['an instance-suffix alias', 'PLUGIN_MAIL_PACK__EU'],
		['a trailing separator', 'PLUGIN_MAIL_PACK_'],
		['a bare prefix', 'PLUGIN_'],
		['a name with punctuation', 'PLUGIN_MAIL-PACK'],
	])('refuses %s', (_label, envVar) => {
		expect(issuePaths(manifestWith({ requiredEnvVars: [envVar] }))).toContain(
			`${PATH}.requiredEnvVars[0]`
		);
		expect(isPluginSendTransportEnvVar(envVar)).toBe(false);
	});

	it('refuses a name declared in both lists — one variable, one meaning', () => {
		expect(
			issuePaths(
				manifestWith({
					requiredEnvVars: ['PLUGIN_MAIL_PACK_TOKEN'],
					optionalEnvVars: ['PLUGIN_MAIL_PACK_TOKEN'],
				})
			)
		).toContain(`${PATH}.optionalEnvVars[0]`);
	});

	it('refuses a repeat inside one list', () => {
		expect(
			issuePaths(
				manifestWith({
					requiredEnvVars: ['PLUGIN_MAIL_PACK_TOKEN', 'PLUGIN_MAIL_PACK_TOKEN'],
				})
			)
		).toContain(`${PATH}.requiredEnvVars[1]`);
	});

	it('bounds how many variables the host resolves per send', () => {
		// Reported by the SNAPSHOTTER, which bounds the array before anything reads
		// it — the same layer that bounds `retryDelays`, and the reason an
		// over-long list never becomes work.
		const many = Array.from({ length: 13 }, (_, index) => `PLUGIN_MAIL_PACK_V${index}`);
		expect(issuePaths(manifestWith({ requiredEnvVars: many }))).toContain(
			`${PATH}.requiredEnvVars`
		);
	});

	it.each(['requiredEnvVars', 'optionalEnvVars'] as const)(
		'rejects a %s accessor without evaluating it',
		(field) => {
			let reads = 0;
			const transport = transportDefinition();
			Object.defineProperty(transport, field, {
				enumerable: true,
				get() {
					reads += 1;
					return ['PLUGIN_MAIL_PACK_TOKEN'];
				},
			});

			expect(
				issuePaths({
					id: 'mail-pack',
					version: '1.0.0',
					capabilities: ['send:transport'],
					flag: { default: false },
					contributes: { sendTransports: [transport] },
				})
			).toContain(`${PATH}.${field}`);
			expect(reads).toBe(0);
		}
	);

	it('reads the names from a SNAPSHOT, so a live array cannot be swapped after validation', () => {
		// The manifest's array is captured before the validator reads it, exactly as
		// `retryDelays` and the webhook's nested descriptors are: otherwise a
		// manifest could pass the namespace check and then hand the composer a
		// different variable name to resolve.
		const live = ['PLUGIN_MAIL_PACK_TOKEN'];
		const parsed = parsePluginManifest(manifestWith({ requiredEnvVars: live }));
		live[0] = 'MTA_API_KEY';

		expect(parsed.contributes?.sendTransports?.[0]?.requiredEnvVars).toEqual([
			'PLUGIN_MAIL_PACK_TOKEN',
		]);
	});
});

describe('declared capability fields', () => {
	it('accepts the values this tier can honour', () => {
		const parsed = parsePluginManifest(
			manifestWith({
				supportsCustomReturnPath: 'yes',
				messageIdSource: 'composed',
				deduplicatesOnIdempotencyKey: true,
			})
		);
		const transport = parsed.contributes?.sendTransports?.[0];

		expect(transport?.supportsCustomReturnPath).toBe('yes');
		expect(transport?.messageIdSource).toBe('composed');
		expect(transport?.deduplicatesOnIdempotencyKey).toBe(true);
	});

	it.each([
		// `probe` is a legal core value whose evidence is a real send carrying a
		// signed VERP local part — a wire this contract does not have.
		['probe', { supportsCustomReturnPath: 'probe' }, `${PATH}.supportsCustomReturnPath`],
		['maybe', { supportsCustomReturnPath: 'maybe' }, `${PATH}.supportsCustomReturnPath`],
		[
			// `idempotency-key` turns on a pre-dispatch identity binding that is still
			// MTA-shaped; generalizing it is backend work no manifest can do.
			'idempotency-key',
			{ messageIdSource: 'idempotency-key' },
			`${PATH}.messageIdSource`,
		],
		['a non-string source', { messageIdSource: 7 }, `${PATH}.messageIdSource`],
		[
			'a non-boolean dedup claim',
			{ deduplicatesOnIdempotencyKey: 'true' },
			`${PATH}.deduplicatesOnIdempotencyKey`,
		],
	])('refuses %s', (_label, overrides, path) => {
		expect(issuePaths(manifestWith(overrides))).toContain(path);
	});

	it('still refuses a field the contract does not have', () => {
		expect(issuePaths(manifestWith({ domainVerification: 'api' }))).toContain(
			`${PATH}.domainVerification`
		);
	});
});
