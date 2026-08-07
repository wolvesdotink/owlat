import type { PluginId, PluginReplayBoundSignatureContract } from '@owlat/plugin-kit';
import { isSendProviderKind, sendProviderCatalogEntry } from '../lib/sendProviders/catalog';
import { BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG } from './sendTransportWebhookCatalog.generated';
import { BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_MODULES } from './sendTransportWebhookModules.generated';
import {
	defineHostedContributionCatalog,
	type HostedContributionDefinition,
} from './hostedContributionCatalog';

/**
 * Host view of a bundled send transport's FEEDBACK half (the seams plan's D6,
 * wired by P2.2) — the declaration side, plus the executable parse half it is
 * paired with.
 *
 * Two things live here because they are one fact with two representations, and
 * the whole value of the pair is that they are checked against each other at
 * module load: a catalog entry with no module is a route that 500s a retrying
 * provider, and a module with no catalog entry is executable code no signature
 * contract governs. Both are refused before the deployment serves a request,
 * exactly as `lib/sendProviders/index.ts` does for the send half.
 *
 * WHAT THE HOST OWNS. The `signature` contract here is what the route verifies
 * with — header, HMAC family, encoding, secret variable and the replay
 * provisions — and the plugin's module never sees it. `storeRawPayload` is the
 * adapter's opt-in to raw retention; absent, the verified body is parsed and
 * dropped.
 */
export interface HostedSendTransportWebhookDefinition extends HostedContributionDefinition<'send:transport'> {
	/** The contribution's local id; `kind` is this namespaced by the plugin id. */
	readonly localId: string;
	readonly signature: PluginReplayBoundSignatureContract;
	readonly storeRawPayload: boolean;
}

/** The parse-only half. Authenticity was decided before this is called. */
export interface HostedSendTransportWebhookModule {
	parseEvents(rawBody: string): unknown;
}

/** One resolved feedback surface: what to verify with, and what to parse with. */
export interface HostedSendTransportWebhook {
	readonly definition: HostedSendTransportWebhookDefinition;
	readonly module: HostedSendTransportWebhookModule;
}

const CATALOG = defineHostedContributionCatalog<HostedSendTransportWebhookDefinition>(
	BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG,
	'send transport webhook'
);

interface GeneratedWebhookModule {
	readonly kind: string;
	readonly pluginId: string;
	readonly module: unknown;
}

/**
 * Resolved surfaces keyed by PLUGIN ID, because that is what the route is keyed
 * by: `/webhooks/plugin/<pluginId>`.
 *
 * The manifest validator already refuses a second webhook per plugin, and this
 * asserts it again rather than trusting it — the map is built from generated
 * files, and a hand-edited or stale artifact is precisely the case where the
 * validator's guarantee no longer holds.
 */
const BY_PLUGIN_ID = new Map<string, HostedSendTransportWebhook>();
/** Signing variables already spoken for, so no two webhooks can share one. */
const SECRET_ENV_VARS = new Set<string>();

for (const generated of BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_MODULES as readonly GeneratedWebhookModule[]) {
	const definition = CATALOG.byKind(generated.kind);
	if (
		!definition ||
		definition.pluginId !== generated.pluginId ||
		BY_PLUGIN_ID.has(generated.pluginId)
	) {
		throw new TypeError('Invalid bundled send transport webhook registry');
	}
	// The feedback half must belong to a transport the composed send catalog
	// actually holds, under the same owner. Otherwise a webhook could dispatch
	// events attributed to a kind that never sends — outcomes graded against an
	// arm the measurement plane does not have.
	if (!isSendProviderKind(definition.kind)) {
		throw new TypeError('Bundled send transport webhook names an unknown transport kind');
	}
	if (sendProviderCatalogEntry(definition.kind).pluginId !== definition.pluginId) {
		throw new TypeError('Bundled send transport webhook is not owned by its transport');
	}
	// ONE SECRET, ONE PLUGIN. The manifest validator sees one manifest at a time,
	// so nothing upstream stops two bundled plugins from naming the same signing
	// variable — and if two did, a body signed for one would verify at the other's
	// route and be dispatched under the other's kind, grading a delivery against
	// the wrong measurement arm. Refused at module load, where a composition
	// mistake is a deployment that does not start rather than a request that is
	// silently misattributed.
	if (SECRET_ENV_VARS.has(definition.signature.secretEnvVar)) {
		throw new TypeError('Two bundled send transport webhooks share a signing secret');
	}
	SECRET_ENV_VARS.add(definition.signature.secretEnvVar);
	BY_PLUGIN_ID.set(generated.pluginId, {
		definition,
		module: parseHostedWebhookModule(generated.module),
	});
}
if (CATALOG.all.length !== BY_PLUGIN_ID.size) {
	throw new TypeError('Bundled send transport webhook catalog is missing an executable module');
}

/**
 * The feedback surface a plugin id addresses, or `undefined` when the id names
 * no bundled webhook. `undefined` is the route's 404: an unknown id must never
 * reach signature verification, let alone dispatch.
 *
 * Lookup is by `Map`, so a prototype key (`constructor`, `__proto__`) resolves
 * to nothing rather than to an inherited member being called as an adapter.
 */
export function pluginSendTransportWebhookFor(
	pluginId: string
): HostedSendTransportWebhook | undefined {
	return BY_PLUGIN_ID.get(pluginId);
}

/**
 * The transport kind's definition, for the runtime-authorization seam: it
 * resolves a namespaced kind to its owning-plugin-tagged declaration exactly as
 * every other hosted bucket does.
 */
export function pluginSendTransportWebhookDefinition(
	kind: string
): { readonly pluginId: PluginId } | undefined {
	return CATALOG.byKind(kind);
}

/**
 * Accept only a plain object exposing exactly `parseEvents` as a data property.
 *
 * The same bar `pluginProvider.parseHostedSendTransportModule` sets for the send
 * half: generated imports are code, and code that reached the registry with a
 * getter, a prototype, or a missing method is a failure that must happen at
 * module load — not one frame inside a live webhook.
 */
function parseHostedWebhookModule(input: unknown): HostedSendTransportWebhookModule {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('Invalid bundled send transport webhook module');
	}
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError('Invalid bundled send transport webhook module');
	}
	const descriptors = Object.getOwnPropertyDescriptors(input);
	const keys = Reflect.ownKeys(descriptors);
	const parseEvents = descriptors['parseEvents'];
	if (
		keys.length !== 1 ||
		!parseEvents?.enumerable ||
		!('value' in parseEvents) ||
		typeof parseEvents.value !== 'function'
	) {
		throw new TypeError('Invalid bundled send transport webhook module');
	}
	return Object.freeze({
		parseEvents: parseEvents.value as (rawBody: string) => unknown,
	});
}
