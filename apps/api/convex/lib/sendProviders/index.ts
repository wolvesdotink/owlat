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
import { mandrillSendProvider } from './mandrill';
import { BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES } from '../../plugins/sendTransportModules.generated';
import { SEND_PROVIDER_CATALOG, sendProviderCatalogEntry, isCoreSendProviderKind } from './catalog';
import { createHostedSendProvider, type HostedSendProviderModule } from './pluginProvider';
import type {
	CoreSendProviderKind,
	DispatchExtrasInput,
	SendProviderExtras,
	SendProviderKind,
	SendProviderModule,
	SystemMailExtrasInput,
} from './types';

export type {
	SendProviderKind,
	SendProviderModule,
	DispatchExtrasInput,
	DispatchReentryRetryState,
	ExtrasFor,
	MtaExtras,
	MtaIpPool,
	SesExtras,
	ResendExtras,
	SmtpExtras,
	MandrillExtras,
	EmailSendAttempt,
	EmailSendParams,
	EmailAttachment,
	DispatchResult,
	SendProviderExtras,
	SystemMailExtrasInput,
} from './types';
export { EmailErrorCode, isRetryableErrorCode, isSendProviderKind } from './types';
export type {
	SendTransportId,
	SendTransportRecord,
	// Exported alongside the error class so a caller catching it can narrow
	// `reason` without restating the union.
	SendTransportResolutionReason,
} from './transports';
export {
	SendTransportResolutionError,
	defaultSendTransportId,
	listSendTransports,
	namedSendTransportId,
	resolveSendTransport,
} from './transports';

// Registry — keyed by `SendProviderKind`. The dispatch helper calls
// `providerFor(kind)` to get the adapter; no caller imports adapters directly.
export const SEND_PROVIDERS = {
	mta: mtaSendProvider,
	ses: sesSendProvider,
	resend: resendSendProvider,
	smtp: smtpSendProvider,
	mandrill: mandrillSendProvider,
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
 *
 * Two overloads, so neither caller has to cast. A LITERAL core kind gets that
 * kind's full adapter (`categorizeError`, `runProviderCheck`, typed extras); a
 * NON-LITERAL `SendProviderKind` — what the dispatch helper has once it has
 * resolved a transport id — gets the shared supertype, which is exactly the
 * send-side shape the retry loop needs.
 */
export function providerFor<K extends CoreSendProviderKind>(kind: K): SendProviderModule<K>;
export function providerFor(
	kind: SendProviderKind
): SendProviderModule<SendProviderKind> | HostedSendProviderModule;
export function providerFor(
	kind: SendProviderKind
): SendProviderModule<SendProviderKind> | HostedSendProviderModule {
	const mod: SendProviderModule<SendProviderKind> | HostedSendProviderModule | undefined =
		isCoreSendProviderKind(kind) ? SEND_PROVIDERS[kind] : hostedProviders.get(kind);
	if (!mod) throw new TypeError('Unknown send provider');
	return mod;
}

/**
 * Ask a kind's module for its per-send extras.
 *
 * The ONE place a dispatch context becomes a provider's typed extras: the
 * governed boundary supplies the facts, the module decides what to make of
 * them. Nothing here branches on WHICH provider — that was the seam leak this
 * replaced, a `providerKind === 'mta' ? … : 'resend' ? …` chain inside
 * `delivery/governedDispatch.ts` that every new kind had to edit.
 *
 * A module with no builder — and every hosted (plugin) transport, which parses
 * its own extras from a data-only value the host hands it and takes nothing
 * from this boundary — yields the empty extras the governed path always sent.
 */
export function buildDispatchExtrasFor(
	kind: SendProviderKind,
	input: DispatchExtrasInput
): SendProviderExtras {
	if (!isCoreSendProviderKind(kind)) return {};
	return providerFor(kind).buildDispatchExtras?.(input) ?? {};
}

/**
 * The same question for the SYSTEM/AUTH mail path (`systemMail.ts`).
 *
 * Split from {@link buildDispatchExtrasFor} because the INPUTS are genuinely
 * different — the system intake has no durable Send row and therefore none of
 * the governance identities the dispatch input requires (see
 * `SystemMailExtrasInput`) — while the rule about branching is identical: the
 * boundary supplies the facts, the module decides what to make of them, and
 * nothing here knows which provider it is talking to.
 */
export function buildSystemMailExtrasFor(
	kind: SendProviderKind,
	input: SystemMailExtrasInput
): SendProviderExtras {
	if (!isCoreSendProviderKind(kind)) return {};
	return providerFor(kind).buildSystemMailExtras?.(input) ?? {};
}
