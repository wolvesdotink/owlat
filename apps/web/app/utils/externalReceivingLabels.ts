/**
 * Display names for the "keep my current provider" (send-only) receiving mode,
 * carried as MESSAGE KEYS rather than strings.
 *
 * Three surfaces name the provider — the domain row's collapsed hint, the
 * external-receiving guidance panel and the mode switch — and a provider that
 * reads "Google Workspace" in one place and "Google" in another is exactly the
 * drift that makes an operator wonder whether the two are the same setting. One
 * map, typed against the shared `ExternalReceivingProvider` union, so adding a
 * provider to `@owlat/shared/externalReceiving` fails the build here until it
 * has copy.
 *
 * The union is imported as a TYPE ONLY here: this file is copy, and copy needs
 * nothing from the table but the set of keys it has to cover. The guidance panel
 * does import the module at runtime, for the two answers it cannot get any other
 * way — whether the STORED SPF record already carries the provider's include,
 * and which term to name when it does not.
 */
import type { ExternalReceivingProvider } from '@owlat/shared/externalReceiving';

/**
 * Sentence-form names, written to sit mid-sentence ("Receiving stays with your
 * current provider."). `other` is deliberately lowercase and possessive rather
 * than a noun, because there is no brand to name.
 */
export const EXTERNAL_RECEIVING_PROVIDER_KEYS: Record<ExternalReceivingProvider, string> = {
	google: 'components.domains.externalReceiving.providers.google',
	microsoft: 'components.domains.externalReceiving.providers.microsoft',
	other: 'components.domains.externalReceiving.providers.other',
};

/**
 * The same three providers as PICKER OPTIONS. Only `other` differs: "your
 * current provider" reads as an instruction in a dropdown, where the reader is
 * choosing rather than being told.
 */
export const EXTERNAL_RECEIVING_OPTION_KEYS: Record<ExternalReceivingProvider, string> = {
	google: 'components.domains.externalReceiving.providers.google',
	microsoft: 'components.domains.externalReceiving.providers.microsoft',
	other: 'components.domains.externalReceiving.providers.otherOption',
};

/**
 * Picker order — the insertion order of the map above, so a provider can never
 * be added to the copy and then be missing from the list that offers it.
 */
export const EXTERNAL_RECEIVING_PROVIDER_IDS = Object.keys(
	EXTERNAL_RECEIVING_OPTION_KEYS
) as ExternalReceivingProvider[];

/** The default pick when an operator switches to "keep my current provider". */
export const DEFAULT_EXTERNAL_RECEIVING_PROVIDER: ExternalReceivingProvider = 'google';
