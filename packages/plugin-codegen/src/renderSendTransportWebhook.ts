import { parsePluginPackageName, type BundledPlugin } from '@owlat/plugin-host';
import {
	parsePluginId,
	pluginNamespacedKind,
	type PluginReplayBoundSignatureContract,
} from '@owlat/plugin-kit';
import {
	GENERATED_HEADER,
	renderPluginModuleFile,
	type PluginModuleFileEntry,
} from './renderShared';

/**
 * The feedback half of a bundled send transport (the seams plan's D6, wired by
 * P2.2) — its own module for the same reason crons and the automation
 * registries have theirs: `render.ts` is the composition, not the renderer of
 * every artifact.
 */

interface RenderedSendTransportWebhook extends PluginModuleFileEntry {
	readonly localId: string;
	readonly signature: PluginReplayBoundSignatureContract;
	readonly storeRawPayload: boolean;
}

/**
 * The feedback half of every bundled send transport that declares one (D6).
 *
 * Keyed by the same namespaced kind as the send half, and carrying the plugin id
 * the route is addressed by. The manifest validator has already refused a second
 * webhook per plugin, so the emitted list holds at most one entry per plugin id
 * — the host asserts that again at load rather than trusting it.
 */
function sendTransportWebhooksFor(
	plugins: readonly BundledPlugin[]
): readonly RenderedSendTransportWebhook[] {
	return plugins.flatMap((plugin) =>
		(plugin.manifest.contributes?.sendTransports ?? []).flatMap((transport) =>
			transport.webhook
				? [
						{
							packageName: parsePluginPackageName(plugin.packageName),
							pluginId: parsePluginId(plugin.manifest.id),
							localId: transport.id,
							kind: pluginNamespacedKind(plugin.manifest.id, transport.id),
							exportPath: transport.webhook.module.exportPath,
							signature: transport.webhook.signature,
							storeRawPayload: transport.webhook.storeRawPayload === true,
						},
					]
				: []
		)
	);
}

export function renderSendTransportWebhookCatalog(plugins: readonly BundledPlugin[]): string {
	const entries = sendTransportWebhooksFor(plugins)
		.map(
			(webhook) => `\tObject.freeze({
\t\tkind: ${JSON.stringify(webhook.kind)},
\t\tpluginId: ${JSON.stringify(webhook.pluginId)},
\t\tlocalId: ${JSON.stringify(webhook.localId)},
\t\tsignature: Object.freeze({
\t\t\theader: ${JSON.stringify(webhook.signature.header)},
\t\t\talgorithm: ${JSON.stringify(webhook.signature.algorithm)},
\t\t\tencoding: ${JSON.stringify(webhook.signature.encoding)},
\t\t\tsecretEnvVar: ${JSON.stringify(webhook.signature.secretEnvVar)},
\t\t\treplay: Object.freeze({
\t\t\t\ttimestampHeader: ${JSON.stringify(webhook.signature.replay.timestampHeader)},
\t\t\t\ttoleranceSeconds: ${webhook.signature.replay.toleranceSeconds},
\t\t\t}),
\t\t}),
\t\tstoreRawPayload: ${webhook.storeRawPayload},
\t\trequiredCapability: 'send:transport',
\t}),`
		)
		.join('\n');
	const catalog = entries
		? `Object.freeze([\n${entries}\n] as const)`
		: 'Object.freeze([] as const)';
	return `${GENERATED_HEADER}export const BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG = ${catalog};\n`;
}

export function renderSendTransportWebhookModules(plugins: readonly BundledPlugin[]): string {
	// NOT `'use node'`: this registry is imported by the HTTP router, which runs
	// in the Convex isolate. A webhook module parses verified bytes and needs no
	// Node builtin to do it; the send half, which opens sockets, stays in Node.
	return renderPluginModuleFile(sendTransportWebhooksFor(plugins), {
		varPrefix: 'bundledPluginSendTransportWebhook',
		contract: 'PluginSendTransportWebhookModule',
		modulesConst: 'BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_MODULES',
		useNode: false,
	});
}
