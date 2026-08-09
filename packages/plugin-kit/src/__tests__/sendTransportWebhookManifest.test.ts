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
	isPluginSvixSignatureContract,
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

/** The other accepted arm: a console that signs Svix-style (Resend, and many). */
function svixSignature(overrides: Record<string, unknown> = {}) {
	return {
		scheme: 'svix',
		secretEnvVar: 'PLUGIN_POSTMARK_WEBHOOK_SECRET',
		toleranceSeconds: 300,
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
		// The signing secret is a flag requirement, not merely a variable the route
		// reads — see the "an unset signing secret" cases below.
		flag: {
			default: false,
			requiredEnvVars: ['POSTMARK_TOKEN', 'PLUGIN_POSTMARK_WEBHOOK_SECRET'],
		},
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
		const contract = declared?.signature;
		if (contract === undefined || isPluginSvixSignatureContract(contract)) {
			throw new Error('unreachable');
		}
		expect(Object.isFrozen(contract.replay)).toBe(true);
	});

	it('is the arm a contract that spells no scheme means', () => {
		// BACKWARD COMPATIBILITY as a property rather than a promise: every manifest
		// written before the vocabulary widened omits `scheme`, and the absence has
		// to keep meaning THIS contract — not "unspecified".
		const parsed = parsePluginManifest(manifest([transport({ webhook: webhook() })]));
		const contract = parsed.contributes?.sendTransports?.[0]?.webhook?.signature;
		expect(contract).toBeDefined();
		expect(contract && isPluginSvixSignatureContract(contract)).toBe(false);
		expect(contract).not.toHaveProperty('scheme');
	});

	it('accepts the same contract with its scheme spelled out', () => {
		const spelled = validatePluginManifest(
			manifest([
				transport({
					webhook: webhook({ signature: signature({ scheme: 'hmac-timestamp-body' }) }),
				}),
			])
		);
		expect(spelled.ok).toBe(true);
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

/**
 * THE SECOND HOST-VERIFIED ARM (Svix). The capability it closes is the tier's
 * own promise: a bundled plugin wrapping an ESP whose console signs Svix-style
 * could not point that console at `/webhooks/plugin/<id>` at all, because the
 * host was recomputing a different string. Widening the vocabulary does not move
 * the split — the host still holds the secret and still verifies — so what these
 * cases pin is that the arm carries ONLY what is genuinely declarable, and is
 * held to the same fences as the arm above.
 */
describe('the svix arm', () => {
	it('composes, and is frozen', () => {
		const parsed = parsePluginManifest(
			manifest([transport({ webhook: webhook({ signature: svixSignature() }) })])
		);
		const contract = parsed.contributes?.sendTransports?.[0]?.webhook?.signature;

		expect(contract).toEqual(svixSignature());
		expect(Object.isFrozen(contract)).toBe(true);
		expect(contract && isPluginSvixSignatureContract(contract)).toBe(true);
	});

	it.each([
		['a missing tolerance', (({ toleranceSeconds: _t, ...rest }) => rest)(svixSignature())],
		[
			'an unbounded tolerance',
			svixSignature({ toleranceSeconds: PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS + 1 }),
		],
		['a zero tolerance', svixSignature({ toleranceSeconds: 0 })],
		['a fractional tolerance', svixSignature({ toleranceSeconds: 30.5 })],
	] as const)('rejects %s — the same ceiling the other arm is held to', (_label, value) => {
		expect(issuePaths(manifest([transport({ webhook: webhook({ signature: value }) })]))).toContain(
			`${WEBHOOK_PATH}.signature.toleranceSeconds`
		);
	});

	it('rejects a host secret outside the plugin namespace', () => {
		// The one barrier between a manifest and the whole environment reaches every
		// arm, because both arms read it through one predicate.
		const value = svixSignature({ secretEnvVar: 'DATABASE_URL' });
		expect(issuePaths(manifest([transport({ webhook: webhook({ signature: value }) })]))).toContain(
			`${WEBHOOK_PATH}.signature.secretEnvVar`
		);
	});

	it.each(['header', 'algorithm', 'encoding', 'replay'] as const)(
		'refuses %s, which belongs to the scheme and not to the manifest',
		(field) => {
			// Silence would ship the author's belief that the host reads their header.
			// It does not: Svix fixes the headers, the family, the encoding and the
			// signed string, so a declaration of any of them can only disagree.
			const value = svixSignature({ [field]: 'x-anything' });
			expect(
				issuePaths(manifest([transport({ webhook: webhook({ signature: value }) })]))
			).toContain(`${WEBHOOK_PATH}.signature.${field}`);
		}
	);

	it('still requires the signing secret to gate enablement', () => {
		// The join is arm-independent: unset, the route answers 503 to every
		// delivery until the provider deactivates the endpoint.
		const result = validatePluginManifest({
			id: 'mail-pack',
			version: '1.0.0',
			capabilities: ['send:transport'],
			flag: { default: false, requiredEnvVars: ['POSTMARK_TOKEN'] },
			contributes: {
				sendTransports: [transport({ webhook: webhook({ signature: svixSignature() }) })],
			},
		});
		expect(result.ok).toBe(false);
		const issue = result.ok
			? undefined
			: result.issues.find((entry) => entry.path === '$.flag.requiredEnvVars');
		expect(issue?.message).toContain('PLUGIN_POSTMARK_WEBHOOK_SECRET');
	});

	it('counts against the one-webhook-per-plugin rule like any other', () => {
		expect(
			issuePaths(
				manifest([
					transport({ webhook: webhook() }),
					transport({ id: 'postmark-eu', webhook: webhook({ signature: svixSignature() }) }),
				])
			)
		).toContain('$.contributes.sendTransports[1].webhook');
	});
});

describe('a scheme this host cannot verify with', () => {
	it.each([
		// HOST INFRASTRUCTURE: verified against a certificate the host fetches and
		// caches, constrained to a subscription the DEPLOYMENT owns.
		['aws-sns', 'aws-sns'],
		// A LEGACY VENDOR shape, signed over the deployment's own public URL — which
		// no build artifact knows.
		['mandrill-form', 'mandrill-form'],
		['an invented word', 'trust-me'],
		['a non-string', 42],
		['an empty string', ''],
	] as const)('is refused: %s', (_label, scheme) => {
		const value = { ...svixSignature(), scheme };
		expect(issuePaths(manifest([transport({ webhook: webhook({ signature: value }) })]))).toContain(
			`${WEBHOOK_PATH}.signature.scheme`
		);
	});

	it('reports the scheme and nothing else', () => {
		// Falling through to the HMAC rules would bury the real fault under a pile of
		// "missing header/algorithm/encoding" — and would accept the contract's
		// `secretEnvVar` on the way past, reporting it to the flag join as a variable
		// an operator must set for a webhook that can never compose.
		const value = { ...svixSignature(), scheme: 'aws-sns' };
		expect(issuePaths(manifest([transport({ webhook: webhook({ signature: value }) })]))).toEqual([
			`${WEBHOOK_PATH}.signature.scheme`,
		]);
	});

	it('rejects a scheme accessor without evaluating it', () => {
		let reads = 0;
		const contract: Record<string, unknown> = { ...svixSignature() };
		Object.defineProperty(contract, 'scheme', {
			enumerable: true,
			get() {
				reads += 1;
				return 'svix';
			},
		});
		expect(
			issuePaths(manifest([transport({ webhook: webhook({ signature: contract }) })]))
		).toContain(`${WEBHOOK_PATH}.signature.scheme`);
		expect(reads).toBe(0);
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

describe('an unset signing secret must block enablement, not every delivery', () => {
	/**
	 * `secretEnvVar` is the one variable the route cannot proceed without: unset,
	 * the host can verify nothing and answers every delivery `503`, and a run of
	 * non-2xx is what makes a provider deactivate an endpoint. The only mechanism
	 * that catches that BEFORE it costs the operator the feedback channel is
	 * `flag.requiredEnvVars`, which the host checks at enablement and on every
	 * authorization — so the manifest has to require the two to agree.
	 */
	function manifestWithFlag(flag: unknown) {
		return {
			id: 'mail-pack',
			version: '1.0.0',
			capabilities: ['send:transport'],
			flag,
			contributes: { sendTransports: [transport({ webhook: webhook() })] },
		};
	}

	it('rejects a webhook whose secret is not a flag requirement', () => {
		const result = validatePluginManifest(
			manifestWithFlag({ default: false, requiredEnvVars: ['POSTMARK_TOKEN'] })
		);
		expect(result.ok).toBe(false);
		const issue = result.ok
			? undefined
			: result.issues.find((entry) => entry.path === '$.flag.requiredEnvVars');
		expect(issue?.code).toBe('missing');
		expect(issue?.message).toContain('PLUGIN_POSTMARK_WEBHOOK_SECRET');
	});

	it('rejects a webhook on a flag that requires nothing at all', () => {
		expect(issuePaths(manifestWithFlag({ default: false }))).toContain('$.flag.requiredEnvVars');
	});

	it('accepts one that lists it', () => {
		const result = validatePluginManifest(
			manifestWithFlag({
				default: false,
				requiredEnvVars: ['POSTMARK_TOKEN', 'PLUGIN_POSTMARK_WEBHOOK_SECRET'],
			})
		);
		expect(result.ok).toBe(true);
	});

	it('says nothing extra about a transport that declares no webhook', () => {
		// The rule is the webhook's, not the bucket's: a send-only transport has no
		// secret to require, and must not inherit one.
		const result = validatePluginManifest({
			id: 'mail-pack',
			version: '1.0.0',
			capabilities: ['send:transport'],
			flag: { default: false },
			contributes: { sendTransports: [transport()] },
		});
		expect(result.ok).toBe(true);
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
