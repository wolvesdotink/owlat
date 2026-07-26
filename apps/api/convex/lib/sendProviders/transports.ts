/**
 * Send TRANSPORT registry — the dispatch unit above the provider KIND.
 *
 * A provider *kind* (`mta`, `ses`, `resend`, `smtp`, a plugin-contributed kind)
 * describes HOW to talk to a service. A *transport* is one CONFIGURED INSTANCE
 * of a kind. Every kind gets one default instance for free — it reads the
 * unsuffixed variables the deployment already sets, so the shipped
 * single-transport deployment is unchanged. Additional instances are declared
 * in `SEND_TRANSPORT_INSTANCES` and read the same variables under an
 * `__<INSTANCEKEY>` suffix, which is what lets a deployment keep a warm
 * fallback relay while trialling a second one of the same kind.
 *
 * Transport id grammar: `<kind>` for the default instance, `<kind>#<instanceKey>`
 * for a named one. The default id being *identical* to the kind string is
 * deliberate, not a compatibility shim: the kind does not disappear, it is one
 * field of the resolved transport record.
 *
 * There is deliberately NO transports table (plan D4). The catalog
 * (`./catalog.ts`, fed by `plugins/sendTransportCatalog.generated.ts`) already
 * answers "which transports exist and what config do they need"; a second
 * credential model would be a competing abstraction.
 *
 * Resolution FAILS CLOSED. An id that is malformed, names an unknown kind,
 * names an undeclared instance, names an instance of a kind that cannot HAVE
 * instances, or names a declared instance whose config has been removed throws
 * {@link SendTransportResolutionError}. It never degrades to "whatever else is
 * configured" — silently borrowing another transport's credentials would be
 * both a routing and a security regression.
 *
 * Named instances are a CORE-KIND feature. A plugin-contributed kind's
 * configuration is resolved by the plugin host from the plugin's own declared
 * deployment-wide environment, which the `__<INSTANCEKEY>` suffix does not
 * reach; a named instance of such a kind would therefore resolve and then send
 * with the DEFAULT plugin instance's credentials. That is exactly the silent
 * credential borrow this module promises cannot happen, so it is rejected with
 * `instances_unsupported` instead.
 *
 * Isolate-safe: no `'use node'` dependencies, so the routing/read seams can
 * import it.
 */

import type { PluginId } from '@owlat/plugin-kit';
import { getOptional, isEnvPresent } from '../env';
import {
	SEND_PROVIDER_CATALOG,
	isSendProviderKind,
	sendProviderCatalogEntry,
	type SendProviderCatalogEntry,
	type SendProviderKind,
} from './catalog';

/**
 * `<kind>` (default instance) or `<kind>#<instanceKey>` (named instance).
 *
 * Written as a template-literal union rather than a bare `string` so a typo'd
 * kind (`sendProviderDispatch(ctx, 'mtaa', …)`) is rejected at the CALL SITE,
 * the way the pre-refactor `kind: K` parameter was. It is a shape check, not a
 * validity check: whether the id names a transport this deployment actually has
 * is a runtime question, answered by {@link resolveSendTransport}.
 */
export type SendTransportId = SendProviderKind | `${SendProviderKind}#${string}`;

/** Separates the kind from the instance key inside a transport id. */
const SEND_TRANSPORT_INSTANCE_SEPARATOR = '#';

/** Joins a base variable name to an instance key: `SMTP_RELAY_HOST__BACKUP`. */
const SEND_TRANSPORT_ENV_SUFFIX_SEPARATOR = '__';

const MAX_INSTANCE_KEY_LENGTH = 32;
const INSTANCE_KEY_PATTERN = new RegExp(`^[a-z0-9][a-z0-9_-]{0,${MAX_INSTANCE_KEY_LENGTH - 1}}$`);

/**
 * Derived from the grammar, never guessed: the longest kind this deployment
 * actually has (a plugin kind is `plugin.<pluginId>.<localId>`, up to 136
 * characters) plus the separator plus the longest legal instance key. A fixed
 * cap would reject a legitimate long-named plugin transport.
 */
const MAX_TRANSPORT_ID_LENGTH =
	SEND_PROVIDER_CATALOG.reduce((longest, entry) => Math.max(longest, entry.kind.length), 0) +
	SEND_TRANSPORT_INSTANCE_SEPARATOR.length +
	MAX_INSTANCE_KEY_LENGTH;

export interface SendTransportRecord {
	readonly id: SendTransportId;
	/** The provider kind this transport is an instance of. */
	readonly kind: SendProviderKind;
	/** `null` for the deployment-default instance (unsuffixed variables). */
	readonly instanceKey: string | null;
	readonly label: string;
	readonly retryDelays: readonly number[];
	/** Instance-resolved names of the variables this transport's config lives in. */
	readonly requiredEnvVars: readonly string[];
	readonly pluginId?: PluginId;
}

export type SendTransportResolutionReason =
	/** Not a parseable transport id. */
	| 'malformed_id'
	/** Parsed, but the kind is not in the catalog. */
	| 'unknown_kind'
	/** A named instance that `SEND_TRANSPORT_INSTANCES` does not declare. */
	| 'unregistered_instance'
	/** A named instance of a kind that cannot have instances (a plugin kind). */
	| 'instances_unsupported'
	/** A declared instance whose configuration has been removed. */
	| 'revoked';

/**
 * Thrown when a transport id cannot be resolved. Carries the id and a machine
 * reason; the message stays generic so nothing config-shaped is echoed into a
 * log line or an error surface.
 */
export class SendTransportResolutionError extends Error {
	readonly code = 'SEND_TRANSPORT_UNRESOLVED';
	readonly reason: SendTransportResolutionReason;
	/** The rejected id, as given. Typed `string`: an unresolvable id need not
	 *  even have the shape of a {@link SendTransportId}. */
	readonly transportId: string;

	constructor(transportId: string, reason: SendTransportResolutionReason) {
		super(`Unresolvable send transport: ${reason}`);
		this.name = 'SendTransportResolutionError';
		this.reason = reason;
		this.transportId = transportId;
	}
}

/** The id of the deployment-default instance of a kind. */
export function defaultSendTransportId(kind: SendProviderKind): SendTransportId {
	return kind;
}

/** The id of a NAMED instance of a kind. */
export function namedSendTransportId(kind: SendProviderKind, instanceKey: string): SendTransportId {
	return `${kind}#${instanceKey}`;
}

/**
 * The variable name a transport instance reads `base` from. The default
 * instance reads the base name unchanged — that is what keeps a
 * single-transport deployment byte-identical to the shipped behaviour.
 */
export function sendTransportEnvName(base: string, instanceKey: string | null): string {
	if (instanceKey === null) return base;
	const suffix = instanceKey.toUpperCase().replace(/-/g, '_');
	return `${base}${SEND_TRANSPORT_ENV_SUFFIX_SEPARATOR}${suffix}`;
}

interface ParsedSendTransportId {
	readonly kind: string;
	readonly instanceKey: string | null;
}

/** Split an id into kind + instance key, or `null` when it is not well formed. */
function parseSendTransportId(id: string): ParsedSendTransportId | null {
	if (id.length === 0 || id.length > MAX_TRANSPORT_ID_LENGTH) return null;
	const separatorIndex = id.indexOf(SEND_TRANSPORT_INSTANCE_SEPARATOR);
	if (separatorIndex === -1) return { kind: id, instanceKey: null };
	const kind = id.slice(0, separatorIndex);
	const instanceKey = id.slice(separatorIndex + 1);
	if (kind.length === 0) return null;
	if (!INSTANCE_KEY_PATTERN.test(instanceKey)) return null;
	return { kind, instanceKey };
}

interface SendTransportInstanceDeclaration {
	readonly kind: SendProviderKind;
	readonly instanceKey: string;
}

let cachedDeclarationSource: string | null = null;
let cachedDeclarations: readonly SendTransportInstanceDeclaration[] = [];

/**
 * Parse `SEND_TRANSPORT_INSTANCES`. Malformed, duplicate and AMBIGUOUS entries
 * are DROPPED rather than thrown on: a typo in an operator's env must not take
 * the send path down. Dispatching to the id it was meant to declare then fails
 * closed with `unregistered_instance`, which is the honest outcome.
 *
 * Ambiguous means two declarations of the same kind whose instance keys derive
 * the SAME env suffix — `smtp#a-b` and `smtp#a_b` both read
 * `SMTP_RELAY_HOST__A_B`. Two ids sharing one credential set, with separate
 * client caches, is the credential borrow this module exists to prevent, so the
 * SECOND declaration is dropped and only the first keeps the suffix.
 */
function declaredInstances(): readonly SendTransportInstanceDeclaration[] {
	const source = getOptional('SEND_TRANSPORT_INSTANCES') ?? '';
	if (cachedDeclarationSource === source) return cachedDeclarations;

	const claimedEnvSuffixes = new Set<string>();
	const declarations: SendTransportInstanceDeclaration[] = [];
	for (const rawEntry of source.split(',')) {
		const entry = rawEntry.trim();
		if (entry.length === 0) continue;
		const parsed = parseSendTransportId(entry);
		if (!parsed || parsed.instanceKey === null) continue;
		if (!isSendProviderKind(parsed.kind)) continue;
		// Keyed by kind + derived suffix rather than by id: it subsumes the exact
		// duplicate (same key derives the same suffix) and the aliasing pair.
		const envIdentity = `${parsed.kind}${sendTransportEnvName('', parsed.instanceKey)}`;
		if (claimedEnvSuffixes.has(envIdentity)) continue;
		claimedEnvSuffixes.add(envIdentity);
		declarations.push(Object.freeze({ kind: parsed.kind, instanceKey: parsed.instanceKey }));
	}

	cachedDeclarations = Object.freeze(declarations);
	cachedDeclarationSource = source;
	return cachedDeclarations;
}

function buildRecord(
	entry: SendProviderCatalogEntry,
	instanceKey: string | null
): SendTransportRecord {
	return Object.freeze({
		id:
			instanceKey === null
				? defaultSendTransportId(entry.kind)
				: namedSendTransportId(entry.kind, instanceKey),
		kind: entry.kind,
		instanceKey,
		label: instanceKey === null ? entry.label : `${entry.label} (${instanceKey})`,
		retryDelays: entry.retryDelays,
		requiredEnvVars: Object.freeze(
			entry.requiredEnvVars.map((name) => sendTransportEnvName(name, instanceKey))
		),
		...(entry.pluginId === undefined ? {} : { pluginId: entry.pluginId }),
	});
}

/**
 * Whether a NAMED instance still has its configuration. Only named instances
 * are gated on this: the default instance resolves unconditionally so an
 * unconfigured deployment keeps producing exactly the adapter-level
 * `AUTH_FAILED` / "missing variable" outcome it produces today.
 *
 * FAILS CLOSED on an EMPTY requirement list. `[].every(…)` is vacuously true,
 * so a catalog entry that declares no variables would make every named instance
 * of that kind "configured" — a transport with nothing of its own to read can
 * only be reading somebody else's configuration.
 */
function isNamedInstanceConfigured(record: SendTransportRecord): boolean {
	if (record.requiredEnvVars.length === 0) return false;
	return record.requiredEnvVars.every((name) => isEnvPresent(name));
}

/** Whether a kind supports named instances at all (see the module docblock). */
function supportsNamedInstances(entry: SendProviderCatalogEntry): boolean {
	return entry.pluginId === undefined;
}

/**
 * Every transport this deployment can dispatch through, defaults first.
 *
 * CONTRACT: every id returned RESOLVES. A declared named instance that is
 * unconfigured, or belongs to a kind that cannot have instances, is omitted
 * rather than listed — so enumerate-then-dispatch (what the ramp controller
 * does) can never pick an id `resolveSendTransport` would reject. Default
 * instances are always listed: they resolve unconditionally by design, and
 * whether their credentials are present is `providerKindConfigured`'s question.
 */
export function listSendTransports(): readonly SendTransportRecord[] {
	const records: SendTransportRecord[] = SEND_PROVIDER_CATALOG.map((entry) =>
		buildRecord(entry, null)
	);
	for (const declaration of declaredInstances()) {
		const entry = sendProviderCatalogEntry(declaration.kind);
		if (!supportsNamedInstances(entry)) continue;
		const record = buildRecord(entry, declaration.instanceKey);
		if (!isNamedInstanceConfigured(record)) continue;
		records.push(record);
	}
	return Object.freeze(records);
}

/**
 * Resolve a transport id to its record, or throw
 * {@link SendTransportResolutionError}. Never falls back to another transport.
 *
 * Takes a `string`, not a {@link SendTransportId}: this is the runtime
 * validator, so it must be callable with an id that came from storage, an env
 * declaration or an HTTP body and may be any shape at all.
 */
export function resolveSendTransport(transportId: string): SendTransportRecord {
	const parsed = parseSendTransportId(transportId);
	if (!parsed) throw new SendTransportResolutionError(transportId, 'malformed_id');
	if (!isSendProviderKind(parsed.kind)) {
		throw new SendTransportResolutionError(transportId, 'unknown_kind');
	}

	const entry = sendProviderCatalogEntry(parsed.kind);
	const { instanceKey } = parsed;
	if (instanceKey === null) return buildRecord(entry, null);

	if (!supportsNamedInstances(entry)) {
		throw new SendTransportResolutionError(transportId, 'instances_unsupported');
	}

	const isDeclared = declaredInstances().some(
		(declaration) => declaration.kind === parsed.kind && declaration.instanceKey === instanceKey
	);
	if (!isDeclared) throw new SendTransportResolutionError(transportId, 'unregistered_instance');

	const record = buildRecord(entry, instanceKey);
	if (!isNamedInstanceConfigured(record)) {
		throw new SendTransportResolutionError(transportId, 'revoked');
	}
	return record;
}

/** Clears the `SEND_TRANSPORT_INSTANCES` parse cache. Tests only. */
export function _resetSendTransportCacheForTests(): void {
	cachedDeclarationSource = null;
	cachedDeclarations = [];
}
