/**
 * Connected-app domain helpers — validation and safe projection.
 *
 * Pure/v8-safe (no Node, no crypto): usable from both the queries/mutations and,
 * for fast-fail input checks, the Node action layer. The one job this module
 * guarantees is that the sealed secret columns never leak: {@link toPublicConnectedApp}
 * is the single projection every read path returns.
 */

import type { Doc } from '../_generated/dataModel';
import { parsePluginId, type PluginId, type PluginManifest } from '@owlat/plugin-kit';
import { throwInvalidInput } from '../_utils/errors';
import { STRING_LIMITS, validateStringLength } from '../lib/inputGuards';
import { getBundledPluginManifest } from '../plugins/authorization';
import type { ConnectedAppStatus } from './lifecycle';

/** The client-facing shape of a connected app: every field EXCEPT the secret. */
export interface PublicConnectedApp {
	readonly _id: Doc<'connectedApps'>['_id'];
	readonly organizationId: string;
	readonly pluginId: string;
	readonly name: string;
	readonly endpointUrl: string;
	readonly status: ConnectedAppStatus;
	readonly grantedCapabilities: readonly string[];
	readonly secretRotatedAt: number;
	readonly createdByUserId: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly revokedAt?: number;
}

/**
 * Project a stored row to its client-facing shape. The sealed secret columns
 * (`secretCiphertext`/`secretIv`/`secretAuthTag`/`secretEnvelopeVersion`) are
 * omitted by construction — this is the ONLY function read paths return, so a
 * new query cannot accidentally surface the ciphertext.
 */
export function toPublicConnectedApp(row: Doc<'connectedApps'>): PublicConnectedApp {
	return {
		_id: row._id,
		organizationId: row.organizationId,
		pluginId: row.pluginId,
		name: row.name,
		endpointUrl: row.endpointUrl,
		status: row.status,
		grantedCapabilities: row.grantedCapabilities,
		secretRotatedAt: row.secretRotatedAt,
		createdByUserId: row.createdByUserId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		...(row.revokedAt === undefined ? {} : { revokedAt: row.revokedAt }),
	};
}

/** Trim and length-check a connected-app display name; throws on empty/oversized. */
export function validateConnectedAppName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throwInvalidInput('Connected app name is required');
	validateStringLength(trimmed, STRING_LIMITS.NAME, 'Name');
	return trimmed;
}

/**
 * Validate and normalize the hook endpoint URL. Tier-2 endpoints MUST be HTTPS
 * (hooks carry signed request bodies), must have a hostname, and must not embed
 * credentials (a `user:pass@` authority that could smuggle a secret or confuse a
 * fetch). Network-level SSRF enforcement — DNS resolution, private-range and
 * redirect pinning — is applied where the request is actually made (PP-24); this
 * is the write-time shape gate.
 */
export function validateConnectedAppEndpoint(endpointUrl: string): string {
	validateStringLength(endpointUrl, STRING_LIMITS.URL, 'Endpoint URL');
	let parsed: URL;
	try {
		parsed = new URL(endpointUrl);
	} catch {
		throwInvalidInput('Endpoint URL must be a valid absolute URL');
	}
	if (parsed.protocol !== 'https:') {
		throwInvalidInput('Endpoint URL must use https');
	}
	if (!parsed.hostname) {
		throwInvalidInput('Endpoint URL must have a hostname');
	}
	if (parsed.username || parsed.password) {
		throwInvalidInput('Endpoint URL must not embed credentials');
	}
	return parsed.toString();
}

/**
 * Resolve the bound plugin's manifest and check that every requested capability
 * is one the manifest actually declares. This is the restrict-only ceiling at
 * registration: an app may request a subset of the plugin's capabilities and no
 * more. The operator grant is re-checked at runtime, so this can only narrow.
 * Returns the de-duplicated, order-preserved capability list.
 */
export function validateGrantedCapabilities(
	pluginId: string,
	requested: readonly string[]
): string[] {
	let manifest: PluginManifest;
	try {
		const parsed: PluginId = parsePluginId(pluginId);
		manifest = getBundledPluginManifest(parsed);
	} catch {
		throwInvalidInput('Unknown plugin for connected app');
	}
	const declared = new Set<string>(manifest.capabilities);
	const deduped = [...new Set(requested)];
	const unknown = deduped.filter((capability) => !declared.has(capability));
	if (unknown.length > 0) {
		throwInvalidInput(`Capabilities not declared by plugin ${pluginId}: ${unknown.join(', ')}`);
	}
	return deduped;
}
