'use node';

/**
 * Send provider adapter (module) — registry + dispatch.
 *
 * Per ADR-0020. Mirrors `convex/domains/providers/index.ts` (ADR-0018) shape.
 * Adding another send provider is a one-folder change:
 *   1. Create `convex/lib/sendProviders/<kind>/index.ts` with the adapter.
 *   2. Add the literal to `SendProviderKind` in `types.ts`.
 *   3. Add one entry to `SEND_PROVIDERS` below.
 *
 * The compile-time `satisfies` check on the registry catches missing methods.
 * The **Send dispatch (helper)** in `./dispatch.ts` never branches on `kind`.
 */

import { mtaSendProvider } from './mta';
import { sesSendProvider } from './ses';
import { resendSendProvider } from './resend';
import { smtpSendProvider } from './smtp';
import { BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES } from '../../plugins/sendTransportModules.generated';
import {
	SEND_PROVIDER_CATALOG,
	sendProviderCatalogEntry,
	isCoreSendProviderKind,
} from './catalog';
import { createHostedSendProvider, type HostedSendProviderModule } from './pluginProvider';
import type { CoreSendProviderKind, SendProviderKind, SendProviderModule } from './types';

export type {
	SendProviderKind,
	SendProviderModule,
	ExtrasFor,
	MtaExtras,
	SesExtras,
	ResendExtras,
	SmtpExtras,
	EmailSendAttempt,
	EmailSendParams,
	EmailAttachment,
	DispatchResult,
} from './types';
export { EmailErrorCode, isRetryableErrorCode, isSendProviderKind } from './types';

// Registry — keyed by `SendProviderKind`. The dispatch helper calls
// `providerFor(kind)` to get the adapter; no caller imports adapters directly.
export const SEND_PROVIDERS = {
	mta: mtaSendProvider,
	ses: sesSendProvider,
	resend: resendSendProvider,
	smtp: smtpSendProvider,
} as const;

// Compile-time guard: each registry value must satisfy the adapter shape for
// its own kind. The mapped type pins each key to `Module<thatKey>`.
const _typecheck: { [K in CoreSendProviderKind]: SendProviderModule<K> } = SEND_PROVIDERS;
void _typecheck;

interface GeneratedSendTransportModule {
	readonly kind: SendProviderKind;
	readonly pluginId: string;
	readonly module: unknown;
}

const hostedProviders = new Map<SendProviderKind, HostedSendProviderModule>();
for (const generated of BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES as readonly GeneratedSendTransportModule[]) {
	const catalogEntry = sendProviderCatalogEntry(generated.kind);
	if (
		isCoreSendProviderKind(generated.kind) ||
		catalogEntry.pluginId !== generated.pluginId ||
		hostedProviders.has(generated.kind)
	) {
		throw new TypeError('Invalid bundled send transport registry');
	}
	hostedProviders.set(
		generated.kind,
		createHostedSendProvider(generated.kind, catalogEntry.retryDelays, generated.module)
	);
}
if (
	SEND_PROVIDER_CATALOG.some(
		(entry) => entry.pluginId !== undefined && !hostedProviders.has(entry.kind)
	)
) {
	throw new TypeError('Bundled send transport catalog is missing an executable module');
}

/**
 * Look up the adapter for a provider kind. Throws on unknown kinds —
 * callers validate the kind as a literal union before this is called.
 */
export function providerFor<K extends SendProviderKind>(
	kind: K
): K extends CoreSendProviderKind ? SendProviderModule<K> : HostedSendProviderModule {
	const mod = isCoreSendProviderKind(kind)
		? SEND_PROVIDERS[kind as CoreSendProviderKind]
		: hostedProviders.get(kind);
	if (!mod) throw new TypeError('Unknown send provider');
	return mod as K extends CoreSendProviderKind ? SendProviderModule<K> : HostedSendProviderModule;
}
