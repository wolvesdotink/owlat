/**
 * Email-client metadata registry.
 *
 * The static client metadata in ./clients.ts seeds this registry at module
 * load; the renderer's Compatibility scoring reads each client's market share
 * through it.
 *
 * Per-block Feature compatibility and Property compatibility live in Block
 * modules in `@owlat/email-renderer`.
 *
 * Note: the strict ClientSupport interface in ./types.ts pins the 12
 * built-in client keys at compile time, while this registry is keyed by plain
 * strings. Call sites holding a key that may fall outside the strict union
 * must use `lookupClientSupport()` (which returns `undefined` for unknown
 * keys) rather than direct indexing.
 */

import { createRegistry } from '../registry';
import type { ClientSupport, EmailClientInfo, SupportLevel } from './types';

/**
 * Registry of email-client metadata. Keys are the canonical client ids
 * (e.g. 'gmail', 'outlookDesktop').
 */
export const emailClientRegistry = createRegistry<string, EmailClientInfo>('emailClients');

/**
 * Safe lookup against a ClientSupport record for a key that may not be in
 * the strict union. Returns the level or `undefined`.
 */
export function lookupClientSupport(
	support: ClientSupport | Record<string, SupportLevel>,
	clientKey: string
): SupportLevel | undefined {
	return (support as Record<string, SupportLevel>)[clientKey];
}
