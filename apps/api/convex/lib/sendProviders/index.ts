'use node';

/**
 * Send provider adapter (module) — registry + dispatch.
 *
 * Per ADR-0020. Mirrors `convex/domains/providers/index.ts` (ADR-0018) shape.
 * Executable transports are composed in `convex/providers/composition.ts`.
 * `SEND_PROVIDERS` below is the compatibility view for callers that still need
 * the closed core map; dispatch itself asks the composed bundle registry.
 * `__tests__/catalogConsistency.test.ts` restates that guard against the union
 * imported straight from `@owlat/shared`, so the chain cannot quietly be rebuilt
 * on a union local to this app.
 * The **Send dispatch (helper)** in `./dispatch.ts` never branches on `kind`.
 */

import { isCoreSendProviderKind } from './catalog';
import type { HostedSendProviderModule } from './pluginProvider';
import {
	SEND_PROVIDER_BUNDLES,
	runtimeTransportFor,
} from '../../providers/composition';
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
export const SEND_PROVIDERS = Object.fromEntries(
	SEND_PROVIDER_BUNDLES.filter(({ descriptor }) =>
		isCoreSendProviderKind(descriptor.kind)
	).map(({ descriptor, transport }) => [descriptor.kind, transport])
) as { [K in CoreSendProviderKind]: SendProviderModule<K> };

// Compile-time guard: each registry value must satisfy the adapter shape for
// its own kind. The mapped type pins each key to `Module<thatKey>`.
const _typecheck: { [K in CoreSendProviderKind]: SendProviderModule<K> } = SEND_PROVIDERS;
void _typecheck;

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
	return runtimeTransportFor(kind);
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
 * A module with no builder yields the empty extras the governed path always
 * sent. That is now the only reason a kind gets none: since plugin-tier parity
 * (the seams plan's P3.1) a hosted module may export the same builder, so this
 * boundary asks BOTH tiers the same question and the `?? {}` — not a tier test —
 * is what answers for a module that declines.
 *
 * The cast is the tier seam: a hosted builder's return value is the plugin's own
 * extras shape, which is `unknown` to this app by construction (it is re-parsed
 * at the adapter's `parseExtras` boundary before any send sees it), while
 * `SendProviderExtras` is the union of the CORE kinds' shapes. Neither the
 * dispatch helper nor the governed boundary reads inside the value.
 */
export function buildDispatchExtrasFor(
	kind: SendProviderKind,
	input: DispatchExtrasInput
): SendProviderExtras {
	return (extrasModuleFor(kind)?.buildDispatchExtras?.(input) ?? {}) as SendProviderExtras;
}

/**
 * The module a kind's extras come from, or `null` for a kind this composition
 * has none for.
 *
 * DELIBERATELY NOT `providerFor`, which throws: asking for extras is not
 * dispatching. Every send resolves its transport first and fails closed there on
 * an unknown kind, loudly and before any attempt, so a throw HERE could only ever
 * fire on a path that is not sending — and the honest answer on such a path is
 * the empty extras the governed boundary has always passed, not an exception
 * raised inside somebody else's error handling.
 */
function extrasModuleFor(
	kind: SendProviderKind
): SendProviderModule<SendProviderKind> | HostedSendProviderModule | null {
	if (isCoreSendProviderKind(kind)) return SEND_PROVIDERS[kind];
	try {
		return runtimeTransportFor(kind);
	} catch {
		return null;
	}
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
	return (extrasModuleFor(kind)?.buildSystemMailExtras?.(input) ?? {}) as SendProviderExtras;
}
