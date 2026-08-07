'use node';

/**
 * Send provider adapter (module) — registry + dispatch.
 *
 * Per ADR-0020. Mirrors `convex/domains/providers/index.ts` (ADR-0018) shape.
 * Adding another core send provider:
 *   1. Declare the entry in `packages/shared/src/sendProviderCatalog.ts`. That
 *      is where the kind literal lives: `CoreSendProviderKind` is read off those
 *      entries in `./catalogTypes` and reaches the rest of the backend through
 *      `./catalog` and `./types`, which only re-export it.
 *   2. Create `convex/lib/sendProviders/<kind>/index.ts` with the adapter.
 *   3. Add one entry to `SEND_PROVIDERS` below.
 *
 * Step 1 without step 3 does not compile: the mapped-type annotation on
 * `_typecheck` below keys the registry by the catalog's kind union, so a missing
 * adapter is a build error and a malformed one names the method it lacks.
 * `__tests__/catalogConsistency.test.ts` restates that guard against the union
 * imported straight from `@owlat/shared`, so the chain cannot quietly be rebuilt
 * on a union local to this app.
 * The **Send dispatch (helper)** in `./dispatch.ts` never branches on `kind`.
 */

import { mtaSendProvider } from './mta';
import { sesSendProvider } from './ses';
import { resendSendProvider } from './resend';
import { smtpSendProvider } from './smtp';
import { mandrillSendProvider } from './mandrill';
import { BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES } from '../../plugins/sendTransportModules.generated';
// The entry accessor, not a lookup — the composed entry is already in hand at the
// one site that asks. `returnPathCapability.ts` reads it from here for the same
// reason.
import { supportsCustomReturnPathOf } from '@owlat/shared';
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
	const instanceEnvVars = catalogEntry.instanceEnvVars ?? [];
	const hosted = createHostedSendProvider(
		generated.kind,
		catalogEntry.retryDelays,
		generated.module,
		{
			instanceEnvVars,
			// THE INTERSECTION, not the gate. A plugin entry's presence gate is a
			// UNION that also carries the contributing PLUGIN's deployment-wide flag
			// variables, and those are not this transport's to be handed — so a
			// variable is required-for-a-send only if it is also instance-scoped.
			requiredEnvVars: catalogEntry.requiredEnvVars.filter((name) =>
				instanceEnvVars.includes(name)
			),
		}
	);
	// THE DEDUP CLAIM IS A PAIR, and this is the half a manifest cannot make on
	// its own: the catalog says a repeat is safe, and the module's
	// `buildSystemMailExtras` is what carries the key the repeat would be
	// deduplicated on. Without it, `systemMailRetryDisposition` reports an
	// ambiguous password reset as `safe_to_retry` while the key never reached the
	// provider — and the "retry" is a second mail to a real person. Refused at
	// module load, where it is a deployment that does not start rather than a
	// wrong answer nobody attributes to a plugin. (This replaces the blanket
	// refusal of the declaration itself, which stood only while the plugin tier
	// had no extras contract at all.)
	if (catalogEntry.deduplicatesOnIdempotencyKey === true && !hosted.buildSystemMailExtras) {
		throw new TypeError(
			`Bundled send transport '${generated.kind}' declares deduplicatesOnIdempotencyKey: true ` +
				'but its module exports no buildSystemMailExtras, so the system/auth mail path cannot ' +
				'hand it the key it would deduplicate on. See buildSystemMailExtras in ' +
				'lib/sendProviders/systemMailExtras.ts.'
		);
	}
	// THE RETURN-PATH CLAIM IS THE SAME SHAPE OF PAIR, and it is refused the same
	// way. `buildDispatchExtras` is the ONLY wire that carries a return-path host
	// to a hosted module, so a transport declaring `yes` without one keeps its own
	// envelope sender while `resolveReturnPathCapabilityForEntry` grades the arm
	// `supported` and hands the ramp the COMPARABLE bounce tolerance. Its bounces
	// then land at the provider, our VERP stream sees ~0 for that arm, and the
	// controller ramps its share against evidence that structurally cannot arrive —
	// the measurement bias with no symptom, which is why it is a boot failure and
	// not a warning.
	if (supportsCustomReturnPathOf(catalogEntry) === 'yes' && !hosted.buildDispatchExtras) {
		throw new TypeError(
			`Bundled send transport '${generated.kind}' declares supportsCustomReturnPath: 'yes' ` +
				'but its module exports no buildDispatchExtras, so the host has no way to hand it ' +
				'the return-path host it claims to honour. See buildDispatchExtras in ' +
				'lib/sendProviders/pluginProvider.ts.'
		);
	}
	hostedProviders.set(generated.kind, hosted);
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
	return hostedProviders.get(kind) ?? null;
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
