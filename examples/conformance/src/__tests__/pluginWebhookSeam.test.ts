/**
 * THE PLUGIN FEEDBACK SEAM, END TO END (the seams plan's D6, wired by P2.2).
 *
 * The other suites in this piece each own one link: the kit's validator, the
 * renderer's output, the host's registry, the route's gates. This one walks the
 * whole chain the way a provider author actually experiences it —
 *
 *     manifest  →  host validation  →  composition  →  codegen artifacts
 *
 * — and asserts the two properties that only appear when the links are joined:
 * a webhook a plugin declares arrives at the host with EXACTLY the contract it
 * declared (a renderer that dropped `replay`, or flipped `storeRawPayload`, would
 * be a silently weakened endpoint that every per-link suite still calls green),
 * and a webhook without a verifier never becomes an artifact at all, because it
 * never becomes a manifest.
 *
 * The generated catalog is evaluated here rather than pattern-matched. It is
 * data-only by construction — literals inside `Object.freeze`, no imports, no
 * identifiers — which is what makes reading it back the honest check: the
 * assertion is then about the VALUES the host will load, not about the text.
 */

import { describe, expect, it } from 'vitest';
import { composeBundledPlugins } from '@owlat/plugin-host';
import { renderPluginComposition } from '@owlat/plugin-codegen';
import { validatePluginManifest } from '@owlat/plugin-kit';
import { evaluateGeneratedArtifact } from '../generatedArtifact';

const PACKAGE_NAME = '@acme/postmark-pack';

const SIGNATURE = Object.freeze({
	header: 'x-postmark-signature',
	algorithm: 'hmac-sha256',
	encoding: 'hex',
	secretEnvVar: 'PLUGIN_POSTMARK_WEBHOOK_SECRET',
	replay: Object.freeze({ timestampHeader: 'x-postmark-timestamp', toleranceSeconds: 300 }),
});

function manifest(webhook: unknown, overrides: Record<string, unknown> = {}) {
	return {
		id: 'postmark-pack',
		version: '1.0.0',
		capabilities: ['send:transport'],
		// The signing secret is a precondition of ENABLEMENT, not merely a variable
		// the route reads: unset, the host can verify nothing and answers every
		// delivery 503. See the "a secret an operator is never asked for" case.
		flag: {
			default: false,
			requiredEnvVars: ['POSTMARK_TOKEN', 'PLUGIN_POSTMARK_WEBHOOK_SECRET'],
		},
		contributes: {
			sendTransports: [
				{
					id: 'postmark',
					label: 'Postmark',
					module: { exportPath: './convex/transport' },
					retryDelays: [1_000],
					...(webhook === undefined ? {} : { webhook }),
				},
			],
		},
		...overrides,
	};
}

function render(webhook: unknown) {
	const result = validatePluginManifest(manifest(webhook));
	expect(result.ok, 'fixture manifest must validate').toBe(true);
	if (!result.ok) throw new Error('unreachable');
	return renderPluginComposition(
		composeBundledPlugins([{ packageName: PACKAGE_NAME, manifest: result.manifest }])
	);
}

describe('the declared contract survives composition unchanged', () => {
	const rendered = render({
		module: { exportPath: './convex/webhook' },
		signature: SIGNATURE,
		storeRawPayload: true,
	});

	it('reaches the host as data the route can verify against', () => {
		const catalog = evaluateGeneratedArtifact(
			rendered.sendTransportWebhookCatalog,
			'BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG'
		) as readonly Record<string, unknown>[];

		expect(catalog).toEqual([
			{
				// Namespaced by the host, not by the plugin: the kind the send half is
				// keyed by, so feedback and sends grade the same arm.
				kind: 'plugin.postmark-pack.postmark',
				pluginId: 'postmark-pack',
				localId: 'postmark',
				signature: {
					header: 'x-postmark-signature',
					algorithm: 'hmac-sha256',
					encoding: 'hex',
					secretEnvVar: 'PLUGIN_POSTMARK_WEBHOOK_SECRET',
					// The replay provisions are the difference between an endpoint that
					// accepts a captured request once and one that accepts it forever.
					replay: { timestampHeader: 'x-postmark-timestamp', toleranceSeconds: 300 },
				},
				storeRawPayload: true,
				requiredCapability: 'send:transport',
			},
		]);
	});

	it('imports the parse half from the package, in the isolate runtime', () => {
		// The router runs in the Convex isolate; a `'use node'` registry there is a
		// push-time failure, and it would be one nobody sees until deploy.
		expect(rendered.sendTransportWebhookModules).not.toContain("'use node'");
		expect(rendered.sendTransportWebhookModules).toContain(`from "${PACKAGE_NAME}/convex/webhook"`);
		expect(rendered.sendTransportWebhookModules).toContain(
			'satisfies PluginSendTransportWebhookModule'
		);
	});

	it('keeps the two halves of the bundle apart', () => {
		// One provider, two runtimes: the send half opens sockets (Node), the
		// feedback half parses verified bytes (isolate). Crossing them breaks the
		// deployment, so the artifacts must never import each other's module.
		expect(rendered.sendTransportModules).toContain("'use node';");
		expect(rendered.sendTransportModules).not.toContain('/convex/webhook');
		expect(rendered.sendTransportWebhookModules).not.toContain('/convex/transport');
	});

	it('leaves the composition artifacts free of executable plugin paths', () => {
		for (const artifact of [rendered.convex, rendered.nuxt]) {
			expect(artifact).not.toContain('/convex/webhook');
		}
	});
});

describe('a transport WITHOUT a webhook', () => {
	const rendered = render(undefined);

	it('produces empty feedback artifacts while still producing a transport', () => {
		expect(
			evaluateGeneratedArtifact(
				rendered.sendTransportWebhookCatalog,
				'BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG'
			)
		).toEqual([]);
		expect(rendered.sendTransportCatalog).toContain('plugin.postmark-pack.postmark');
	});
});

describe('a webhook the host cannot verify never becomes an artifact', () => {
	it.each([
		['no signature contract', { module: { exportPath: './convex/webhook' } }],
		[
			'no replay provisions',
			{
				module: { exportPath: './convex/webhook' },
				signature: (({ replay: _r, ...rest }) => rest)(SIGNATURE),
			},
		],
		[
			'a tolerance beyond the ceiling',
			{
				module: { exportPath: './convex/webhook' },
				signature: {
					...SIGNATURE,
					replay: { timestampHeader: 'x-postmark-timestamp', toleranceSeconds: 86_400 },
				},
			},
		],
		[
			'a signing secret outside the plugin namespace',
			{
				module: { exportPath: './convex/webhook' },
				signature: { ...SIGNATURE, secretEnvVar: 'DATABASE_URL' },
			},
		],
		[
			'an export path that escapes the package',
			{ module: { exportPath: '../../host/secrets' }, signature: SIGNATURE },
		],
	] as const)('is refused at validation: %s', (_label, webhook) => {
		// Refused BEFORE codegen, which is what makes the guarantee structural: the
		// host never has to decide at runtime whether a bundled webhook is
		// trustworthy, because an untrustworthy one cannot have been bundled.
		const result = validatePluginManifest(manifest(webhook));
		expect(result.ok).toBe(false);
	});

	it('is refused at validation: a secret an operator is never asked for', () => {
		// The one failure the other cases cannot express, because it is not a
		// property of the webhook at all: a perfectly-formed contract whose secret
		// is absent from `flag.requiredEnvVars`. Nothing then blocks enablement, the
		// operator pastes the URL into the provider console, and every delivery is
		// answered 503 until the provider deactivates the endpoint — a feedback
		// channel lost to a variable nobody was ever asked to set. The join has to
		// hold at the seam, not just inside the kit's own suite, because it is the
		// only rule here that spans two top-level sections of the manifest.
		const result = validatePluginManifest(
			manifest(
				{ module: { exportPath: './convex/webhook' }, signature: SIGNATURE },
				{ flag: { default: false, requiredEnvVars: ['POSTMARK_TOKEN'] } }
			)
		);
		expect(result.ok).toBe(false);
		const issue = result.ok
			? undefined
			: result.issues.find((entry) => entry.path === '$.flag.requiredEnvVars');
		expect(issue?.message).toContain('PLUGIN_POSTMARK_WEBHOOK_SECRET');
	});
});
