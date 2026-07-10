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
import type { SendProviderKind, SendProviderModule } from './types';

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
export { EmailErrorCode, isRetryableErrorCode } from './types';

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
const _typecheck: { [K in SendProviderKind]: SendProviderModule<K> } = SEND_PROVIDERS;
void _typecheck;

/**
 * Look up the adapter for a provider kind. Throws on unknown kinds —
 * callers validate the kind as a literal union before this is called.
 */
export function providerFor<K extends SendProviderKind>(kind: K): SendProviderModule<K> {
	const mod = SEND_PROVIDERS[kind];
	if (!mod) {
		throw new Error(`Unknown send provider: ${kind}`);
	}
	return mod as unknown as SendProviderModule<K>;
}

/**
 * Type guard: is the given string a recognized provider kind?
 */
export function isSendProviderKind(kind: string | undefined | null): kind is SendProviderKind {
	return kind === 'mta' || kind === 'ses' || kind === 'resend' || kind === 'smtp';
}
