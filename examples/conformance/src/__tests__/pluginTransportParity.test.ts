/**
 * THE PLUGIN TRANSPORT'S CAPABILITY CONTRACT, END TO END (the seams plan's D4,
 * wired by P3.1).
 *
 * The sibling suites each own one link — the kit's validator, the renderer's
 * output, the host's registry and resolver. This one walks the chain a provider
 * author actually experiences,
 *
 *     manifest  →  host validation  →  composition  →  generated catalog
 *
 * — and asserts the property that only appears when the links are joined: what a
 * transport DECLARES is what the host will load. A renderer that dropped
 * `instanceEnvVars` would leave the kind unable to have named instances while
 * every per-link suite still passed; one that widened `requiredEnvVars` to the
 * plugin's flag variables would demand a suffixed copy of a deployment-wide
 * switch before any instance could resolve.
 *
 * The generated catalog is EVALUATED rather than pattern-matched, for the reason
 * the webhook suite gives: it is data-only by construction, so reading it back
 * asserts the values the host loads instead of the text a grep matched.
 */

import { describe, expect, it } from 'vitest';
import { composeBundledPlugins } from '@owlat/plugin-host';
import { renderPluginComposition } from '@owlat/plugin-codegen';
import { validatePluginManifest } from '@owlat/plugin-kit';
import { evaluateGeneratedArtifact } from '../generatedArtifact';

const PACKAGE_NAME = '@acme/postmark-pack';

function manifest(transport: Record<string, unknown>, flagEnvVars?: readonly string[]) {
	return {
		id: 'postmark-pack',
		version: '1.0.0',
		capabilities: ['send:transport'],
		// The plugin's ENABLEMENT gate, deliberately not a transport credential:
		// the two lists answer different questions and the composition keeps them
		// apart.
		flag: { default: false, requiredEnvVars: flagEnvVars ?? ['POSTMARK_PACK_ENABLED'] },
		contributes: {
			sendTransports: [
				{
					id: 'postmark',
					label: 'Postmark',
					module: { exportPath: './convex/transport' },
					retryDelays: [1_000],
					...transport,
				},
			],
		},
	};
}

function catalogEntryFor(
	transport: Record<string, unknown>,
	flagEnvVars?: readonly string[]
): Record<string, unknown> {
	const result = validatePluginManifest(manifest(transport, flagEnvVars));
	expect(result.ok, 'fixture manifest must validate').toBe(true);
	if (!result.ok) throw new Error('unreachable');
	const rendered = renderPluginComposition(
		composeBundledPlugins([{ packageName: PACKAGE_NAME, manifest: result.manifest }])
	);
	const [entry] = evaluateGeneratedArtifact(
		rendered.sendTransportCatalog,
		'BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG'
	) as readonly Record<string, unknown>[];
	if (!entry) throw new Error('expected one catalogued transport');
	return entry;
}

function issuePaths(transport: Record<string, unknown>): readonly string[] {
	const result = validatePluginManifest(manifest(transport));
	expect(result.ok, 'fixture manifest must be refused').toBe(false);
	return result.ok ? [] : result.issues.map((issue) => issue.path);
}

describe('a declared capability reaches the host unchanged', () => {
	it('carries configuration, capabilities and derived feedback into the catalog', () => {
		const entry = catalogEntryFor(
			{
				requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'],
				optionalEnvVars: ['PLUGIN_POSTMARK_STREAM'],
				credentialFields: [
					{
						kind: 'secret',
						key: 'token',
						label: 'Server token',
						required: true,
						envVar: 'PLUGIN_POSTMARK_TOKEN',
					},
					{
						kind: 'string',
						key: 'stream',
						label: 'Message stream',
						envVar: 'PLUGIN_POSTMARK_STREAM',
					},
				],
				// The fail-closed default, spelled: it is the only return-path value
				// this tier may declare, and spelling it is what the host re-reads on
				// the artifact.
				supportsCustomReturnPath: 'no',
				messageIdSource: 'composed',
				deduplicatesOnIdempotencyKey: true,
				webhook: {
					module: { exportPath: './convex/webhook' },
					signature: {
						header: 'x-postmark-signature',
						algorithm: 'hmac-sha256',
						encoding: 'hex',
						secretEnvVar: 'PLUGIN_POSTMARK_WEBHOOK_SECRET',
						replay: { timestampHeader: 'x-postmark-timestamp', toleranceSeconds: 300 },
					},
				},
			},
			// A webhook's signing secret must ALSO be a flag requirement — without it
			// the host verifies nothing and answers every delivery 503.
			['POSTMARK_PACK_ENABLED', 'PLUGIN_POSTMARK_WEBHOOK_SECRET']
		);

		expect(entry).toEqual({
			kind: 'plugin.postmark-pack.postmark',
			pluginId: 'postmark-pack',
			localId: 'postmark',
			label: 'Postmark',
			retryDelays: [1_000],
			// THE UNION: the plugin's flag list (which the authoritative dispatch path
			// checks forever, so a transport inside a disabled plugin must never be
			// reported configured) plus the transport's own gate.
			requiredEnvVars: [
				'POSTMARK_PACK_ENABLED',
				'PLUGIN_POSTMARK_WEBHOOK_SECRET',
				'PLUGIN_POSTMARK_TOKEN',
			],
			optionalEnvVars: ['PLUGIN_POSTMARK_STREAM'],
			// Required and optional together: what the host resolves per instance and
			// hands to the module, and what a named instance reads under its suffix.
			instanceEnvVars: ['PLUGIN_POSTMARK_TOKEN', 'PLUGIN_POSTMARK_STREAM'],
			// The credential FORM (D5), carried through as declared. Every `envVar`
			// was joined to one of the two lists above at manifest validation, so a
			// renderer reading this entry cannot ask for a variable no send reads.
			credentialFields: [
				{
					kind: 'secret',
					key: 'token',
					label: 'Server token',
					required: true,
					envVar: 'PLUGIN_POSTMARK_TOKEN',
				},
				{
					kind: 'string',
					key: 'stream',
					label: 'Message stream',
					envVar: 'PLUGIN_POSTMARK_STREAM',
				},
			],
			supportsCustomReturnPath: 'no',
			messageIdSource: 'composed',
			deduplicatesOnIdempotencyKey: true,
			// DERIVED from the webhook declaration — never a field an author could
			// forget or contradict.
			hasProviderFeedback: true,
			requiredCapability: 'send:transport',
		});
	});

	it("refuses a transport that claims the plugin's own flag variable", () => {
		// The two scopes are the whole point of the split, and the collision is a
		// natural manifest to write ("set the token to enable the pack"). Only the
		// transport's own variables take the `__<INSTANCEKEY>` suffix, so a name in
		// both would leave `#eu` graded configured on `PLUGIN_POSTMARK_TOKEN__EU`
		// while the deployment-wide switch went unchecked — a transport listed and
		// routed to inside a plugin nobody enabled, whose every send the
		// authorization path then refuses. Refused where the author can still rename
		// one of the two.
		const result = validatePluginManifest(
			manifest({ requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'] }, [
				'POSTMARK_PACK_ENABLED',
				'PLUGIN_POSTMARK_TOKEN',
			])
		);

		expect(result.ok).toBe(false);
		expect(result.ok ? [] : result.issues.map((issue) => issue.path)).toContain(
			'$.contributes.sendTransports[0].requiredEnvVars'
		);
	});

	it('leaves a transport written against the older contract exactly as it was', () => {
		expect(catalogEntryFor({})).toEqual({
			kind: 'plugin.postmark-pack.postmark',
			pluginId: 'postmark-pack',
			localId: 'postmark',
			label: 'Postmark',
			retryDelays: [1_000],
			requiredEnvVars: ['POSTMARK_PACK_ENABLED'],
			requiredCapability: 'send:transport',
		});
	});
});

describe('a declaration the host could not honour never becomes an artifact', () => {
	it.each([
		[
			'a credential outside the plugin namespace',
			{ requiredEnvVars: ['MTA_API_KEY'] },
			'$.contributes.sendTransports[0].requiredEnvVars[0]',
		],
		[
			'a base name that would alias an instance suffix',
			{ requiredEnvVars: ['PLUGIN_POSTMARK__EU'] },
			'$.contributes.sendTransports[0].requiredEnvVars[0]',
		],
		[
			'a return-path capability whose envelope sender the host would have to sign',
			{ supportsCustomReturnPath: 'yes' },
			'$.contributes.sendTransports[0].supportsCustomReturnPath',
		],
		[
			'a return-path capability this tier cannot prove',
			{ supportsCustomReturnPath: 'probe' },
			'$.contributes.sendTransports[0].supportsCustomReturnPath',
		],
		[
			'a message id the host would have to pre-bind',
			{ messageIdSource: 'idempotency-key' },
			'$.contributes.sendTransports[0].messageIdSource',
		],
		[
			'a configuration with nothing required, which no instance could resolve',
			{ optionalEnvVars: ['PLUGIN_POSTMARK_STREAM'] },
			'$.contributes.sendTransports[0].optionalEnvVars',
		],
		[
			'a credential field naming a variable the transport never declared',
			{
				requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'],
				credentialFields: [
					{
						kind: 'secret',
						key: 'token',
						label: 'Server token',
						required: true,
						envVar: 'PLUGIN_POSTMARK_ELSEWHERE',
					},
				],
			},
			'$.contributes.sendTransports[0].credentialFields[0].envVar',
		],
		[
			'a credential composite this tier does not offer',
			{
				requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'],
				credentialFields: [
					{
						kind: 'host-port',
						key: 'endpoint',
						label: 'Endpoint',
						required: true,
						envVar: 'PLUGIN_POSTMARK_TOKEN',
					},
				],
			},
			'$.contributes.sendTransports[0].credentialFields[0].kind',
		],
	])('refuses %s', (_label, transport, path) => {
		expect(issuePaths(transport)).toContain(path);
	});
});
