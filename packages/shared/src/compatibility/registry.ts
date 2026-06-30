/**
 * Email-client metadata and block-compatibility registries.
 *
 * The static client metadata in ./clients.ts seeds the email-client registry
 * at module load. Third parties (or future built-ins) can call
 * registerEmailClient() / registerBlockCompatibility() to add new clients or
 * additional Feature compatibility rules without rebuilding `@owlat/shared`.
 *
 * Per-block Feature compatibility and Property compatibility live in Block
 * modules in `@owlat/email-renderer`; the Compatibility walker there merges
 * those module-owned baselines with anything plugin code registered via
 * `mergeBlockCompatibility()` below.
 *
 * Note: the strict ClientSupport interface in ./types.ts pins the 12
 * built-in client keys at compile time. A new client registered via this
 * registry will be returned by getAllEmailClients() but its key will be a
 * plain string — call sites that expect strict ClientSupport keys must use
 * the helper `lookupClientSupport()` (which returns `undefined` for unknown
 * keys) rather than direct indexing.
 */

import { createRegistry } from '../registry';
import type { BlockType } from '../types/blocks';
import type {
	ClientSupport,
	EmailClientInfo,
	FeatureCompatibility,
	SupportLevel,
} from './types';

/**
 * Registry of email-client metadata. Keys are the canonical client ids
 * (e.g. 'gmail', 'outlookDesktop'). Third parties may register additional
 * keys; in that case the key is a plain string outside the strict
 * `ClientSupport` union.
 */
export const emailClientRegistry = createRegistry<string, EmailClientInfo>(
	'emailClients',
);

/**
 * Registry of additional block-compatibility entries supplied by plugins.
 * These are merged on top of the static `blockCompatibility` map from
 * ./data.ts when consumers ask for a block's effective compatibility.
 */
export const blockCompatibilityRegistry = createRegistry<BlockType, FeatureCompatibility[]>(
	'blockCompatibility',
);

/**
 * Register email-client metadata.
 *
 * @param key Stable client id (e.g. 'fastmail', 'samsungMail').
 * @param info Display name, render engine, market share.
 */
export function registerEmailClient(key: string, info: EmailClientInfo): void {
	emailClientRegistry.register(key, info);
}

/**
 * Remove a registered email client. Built-in clients can be removed too;
 * doing so will hide them from getAllEmailClients() until re-registered.
 */
export function unregisterEmailClient(key: string): boolean {
	return emailClientRegistry.unregister(key);
}

/**
 * Add additional feature compatibility rules to a block type. Multiple
 * registrations for the same block are merged (last-write-wins replaces
 * the full plugin list).
 */
export function registerBlockCompatibility(
	blockType: BlockType,
	entries: FeatureCompatibility[],
): void {
	blockCompatibilityRegistry.register(blockType, entries);
}

export function unregisterBlockCompatibility(blockType: BlockType): boolean {
	return blockCompatibilityRegistry.unregister(blockType);
}

/**
 * All known email-client metadata, both built-in (seeded from ./data) and
 * registered by plugins.
 */
export function getAllEmailClients(): Record<string, EmailClientInfo> {
	const out: Record<string, EmailClientInfo> = {};
	for (const [key, info] of emailClientRegistry.entries()) {
		out[key] = info;
	}
	return out;
}

/**
 * Look up a single client's metadata, tolerating unknown keys.
 */
export function getEmailClientInfo(key: string): EmailClientInfo | undefined {
	return emailClientRegistry.get(key);
}

/**
 * Effective block compatibility = baseline from ./data merged with any
 * plugin-registered entries.
 *
 * Pass the baseline list (FeatureCompatibility[] from blockCompatibility)
 * and the block type; the helper appends any registered extensions.
 */
export function mergeBlockCompatibility(
	blockType: BlockType,
	baseline: FeatureCompatibility[],
): FeatureCompatibility[] {
	const extra = blockCompatibilityRegistry.get(blockType);
	return extra && extra.length > 0 ? [...baseline, ...extra] : baseline;
}

/**
 * Safe lookup against a ClientSupport record for a key that may not be in
 * the strict union. Returns the level or `undefined`.
 */
export function lookupClientSupport(
	support: ClientSupport | Record<string, SupportLevel>,
	clientKey: string,
): SupportLevel | undefined {
	return (support as Record<string, SupportLevel>)[clientKey];
}
