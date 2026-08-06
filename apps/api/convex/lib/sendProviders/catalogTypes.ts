/**
 * Send-provider catalog — the backend half of the DECLARATION vocabulary.
 *
 * THE VOCABULARY ITSELF MOVED to `packages/shared/src/sendProviderCatalogTypes.ts`
 * with the entries it describes (the seams plan's P1.1 / D1: "one capability
 * catalog, in packages/shared, and everything derives from it"), so web,
 * setup-cli and docs generation read the same declaration instead of restating
 * it. Every name it exports is re-exported below, unchanged.
 *
 * WHAT STAYS HERE is the part that cannot live in a leaf package: the plugin
 * tier's types come from `@owlat/plugin-kit`, which `packages/shared` does not
 * depend on (and should not — the catalog data half is in the web client
 * bundle). So the shared module declares the entry shape and the capability
 * unions, and this module widens both with the two plugin-kit-typed fields and
 * with the plugin kind union.
 *
 * IMPORT THROUGH `catalog.ts`, not through here: it re-exports every name this
 * module exports, so the import site stays `lib/sendProviders/catalog` and
 * `vi.mock` of that module still intercepts the accessors. Adding a type here
 * means adding it to that re-export block too.
 */

import type { PluginId, PluginSendTransportKind } from '@owlat/plugin-kit';
import type { CoreSendProviderKind, SendProviderCatalogEntryShape } from '@owlat/shared';

export type {
	AcceptanceSemantics,
	CoreSendProviderCatalogEntry,
	CoreSendProviderKind,
	DeclaredCustomReturnPathSupport,
	DomainVerificationSupport,
	FeedbackProvenanceTagging,
	IdempotencyKeyDeduplication,
	MessageIdSource,
	SendProviderCatalogEntryShape,
	SendProviderCredentialField,
	SendProviderSetupProbe,
	SendProviderTier,
} from '@owlat/shared';

/**
 * Every kind the backend can dispatch to: the catalog's core kinds plus the
 * namespaced kinds bundled plugins contribute.
 */
export type SendProviderKind = CoreSendProviderKind | PluginSendTransportKind;

/**
 * A catalog entry as the BACKEND sees it — the shared shape, with `kind`
 * narrowed to what this composition can dispatch to and with the two fields a
 * generated plugin entry carries.
 *
 * `pluginId` is what makes an entry hosted: `capability.ts` reads it to check
 * the contributing plugin is still enabled, and `index.ts` pairs it against the
 * generated module registry so a catalogued plugin transport with no executable
 * module is a boot failure rather than a dispatch-time one.
 */
export type SendProviderCatalogEntry = SendProviderCatalogEntryShape & {
	readonly kind: SendProviderKind;
	readonly pluginId?: PluginId;
	readonly requiredCapability?: 'send:transport';
};
