/**
 * Composer-lock derivation for Sealed Mail (E5, flag `sealedMail`). Turns the
 * backend's per-draft `sealState` (mail/sealPolicy.ts `deriveSealState`, exposed
 * to the web by `api.mail.drafts.getComposerSealState`) into ONE honest lock
 * indicator for the compose surface.
 *
 * The honesty audit is a test, not a vibe: every string this can render maps 1:1
 * to a `sealState` the backend actually computed. `willSeal` is the ONLY state
 * that promises encryption; every other state explains, in plain language, why
 * the message would go out unsealed — and for `cannotSeal` sending unsealed is a
 * DECISION: the sender is asked to proceed or cancel (`deriveUnsealedPrompt`)
 * before a single plaintext message leaves, never a silent downgrade.
 *
 * These derivations are module scope, so they never call `useI18n`: every copy
 * field they hand back is a catalog KEY (or a `{ key, params }` pair where the
 * message interpolates something), and the composer resolves it with `t()` at
 * render time, in the active locale.
 *
 * The lock is also shown while the state is still being computed (`checking`), so
 * the compose surface never sits silent about sealing right up until Send.
 *
 * This is the web-side mirror of the Convex `SealState` union (single source is
 * `mail/sealPolicy.ts`); the boundary keeps its own copy per this app's existing
 * cross-package pattern (see `utils/senderAuth.ts`).
 */

import type { SealTone } from './sealTone';

/** Why a draft cannot (or would not automatically) be sealed. Mirrors the Convex `SealSkipReason`. */
export type SealSkipReason =
	| 'flag_off'
	| 'policy_off'
	| 'policy_ask'
	| 'no_recipients'
	| 'recipient_no_key'
	| 'key_changed'
	| 'no_signing_key';

/** Web mirror of the Convex composer `SealState` union (`mail/sealPolicy.ts`). */
export type SealState =
	| { kind: 'willSeal' }
	| { kind: 'keyChanged'; addresses: string[] }
	| { kind: 'cannotSeal'; reason: SealSkipReason };

export type SealSendBlock = 'checking' | 'needs_unsealed_consent' | 'key_changed' | null;

/** Pure mirror of the server send gate, used by button, shortcut and scheduler paths. */
export function sealSendBlock(
	enabled: boolean,
	state: SealState | null,
	allowUnsealed: boolean
): SealSendBlock {
	if (!enabled) return null;
	if (!state) return 'checking';
	if (state.kind === 'willSeal') return null;
	if (state.kind === 'keyChanged') return 'key_changed';
	return allowUnsealed ? null : 'needs_unsealed_consent';
}

/** The three visual tones the lock renders in (shared with the sealed badge). */
export type SealLockTone = SealTone;

/**
 * The lock's discriminator: the three backend seal states plus `checking`, the
 * pre-answer state the composer renders while the per-draft query is in flight.
 */
export type ComposerLockKind = SealState['kind'] | 'checking';

/**
 * A translatable sentence this module hands to whoever renders it: a bare
 * catalog key, or a key plus the values its message interpolates.
 */
export type SealLockText = string | { key: string; params?: Record<string, string | number> };

export interface ComposerLockResult {
	/** Discriminator carried through to the component for styling + branching. */
	kind: ComposerLockKind;
	/** Short lock label — a catalog key, resolved with `t()` at render time. */
	summary: string;
	/** Plain-language explanation — a catalog key or a `{ key, params }` pair. */
	detail: SealLockText;
	tone: SealLockTone;
	icon: string;
	/**
	 * True ONLY for a `cannotSeal` state the sender can actually act on: sending in
	 * plaintext is a decision, so the composer offers a distinct control that opens
	 * the proceed-or-cancel prompt rather than sealing silently or dead-ending.
	 * `willSeal` seals automatically; `keyChanged` defers to the key-change
	 * banner's re-accept; `no_recipients` has nothing to decide yet.
	 */
	allowSendUnsealed: boolean;
}

/**
 * The rotated recipients, as the key-change sentence names them: nobody, one
 * address, or a comma list plus a final conjunction. The conjunction is part of
 * the MESSAGE rather than of a string built here, because word order and the
 * word itself are the translation's business — so the list count picks the key
 * and the addresses travel as parameters.
 */
function keyChangedDetail(addresses: string[]): SealLockText {
	if (addresses.length === 0) return 'shared.sealComposer.keyChanged.detailAnyRecipient';
	if (addresses.length === 1) {
		return {
			key: 'shared.sealComposer.keyChanged.detailOne',
			params: { address: addresses[0] as string },
		};
	}
	return {
		key: 'shared.sealComposer.keyChanged.detailMany',
		params: {
			head: addresses.slice(0, -1).join(', '),
			last: addresses[addresses.length - 1] as string,
		},
	};
}

/**
 * Plain-language reason copy for a `cannotSeal` state, as a catalog key. Every
 * branch is asserted verbatim in the honesty test. The union is total, so no
 * branch can silently over-claim — each one still says the message goes out
 * unsealed.
 */
function cannotSealDetail(reason: SealSkipReason): string {
	switch (reason) {
		case 'policy_off':
			return 'shared.sealComposer.cannotSeal.policyOff';
		case 'recipient_no_key':
			return 'shared.sealComposer.cannotSeal.recipientNoKey';
		case 'no_recipients':
			return 'shared.sealComposer.cannotSeal.noRecipients';
		case 'no_signing_key':
			return 'shared.sealComposer.cannotSeal.noSigningKey';
		case 'policy_ask':
			return 'shared.sealComposer.cannotSeal.policyAsk';
		case 'flag_off':
			return 'shared.sealComposer.cannotSeal.flagOff';
		case 'key_changed':
			return 'shared.sealComposer.cannotSeal.keyChanged';
	}
}

/**
 * Derive the composer lock indicator from a draft's seal state. Pure — no I/O —
 * so the honesty audit can enumerate every reachable string against its state.
 * `null` is the not-yet-answered state (the per-draft query is still in flight):
 * it renders as `checking` rather than as nothing, because an absent lock reads
 * as "nothing to say about sealing" — which is a claim of its own.
 */
export function deriveComposerLock(state: SealState | null): ComposerLockResult {
	if (!state) {
		return {
			kind: 'checking',
			summary: 'shared.sealComposer.checking.summary',
			detail: 'shared.sealComposer.checking.detail',
			tone: 'muted',
			icon: 'lucide:loader-2',
			allowSendUnsealed: false,
		};
	}
	switch (state.kind) {
		case 'willSeal':
			return {
				kind: 'willSeal',
				summary: 'shared.sealComposer.willSeal.summary',
				detail: 'shared.sealComposer.willSeal.detail',
				tone: 'ok',
				icon: 'lucide:lock',
				allowSendUnsealed: false,
			};
		case 'keyChanged':
			return {
				kind: 'keyChanged',
				summary: 'shared.sealComposer.keyChanged.summary',
				detail: keyChangedDetail(state.addresses),
				tone: 'warn',
				icon: 'lucide:key-round',
				allowSendUnsealed: false,
			};
		case 'cannotSeal':
			return {
				kind: 'cannotSeal',
				summary: 'shared.sealComposer.cannotSeal.summary',
				detail: cannotSealDetail(state.reason),
				tone: 'muted',
				icon: 'lucide:lock-open',
				// Nothing to decide until there is someone to send to.
				allowSendUnsealed: state.reason !== 'no_recipients',
			};
	}
}

/**
 * The proceed-or-cancel prompt shown before a message goes out unsealed. Copy
 * only — the caller owns the dialog.
 */
export interface UnsealedSendPrompt {
	/** Catalog key — resolved with `t()` at render time. */
	title: string;
	/**
	 * Why it won't be sealed, then what sending anyway means — ONE catalog key per
	 * reason. The two halves are one message rather than two joined here: a
	 * sentence split around a value is untranslatable.
	 */
	description: string;
	confirmLabel: string;
	cancelLabel: string;
}

/**
 * The per-reason prompt message. Each one states why this draft can't be sealed
 * AND what sending anyway costs, so the decision is never presented without its
 * consequence.
 */
function unsealedPromptDescription(reason: SealSkipReason): string {
	switch (reason) {
		case 'policy_off':
			return 'shared.sealComposer.unsealedPrompt.policyOff';
		case 'recipient_no_key':
			return 'shared.sealComposer.unsealedPrompt.recipientNoKey';
		case 'no_recipients':
			return 'shared.sealComposer.unsealedPrompt.noRecipients';
		case 'no_signing_key':
			return 'shared.sealComposer.unsealedPrompt.noSigningKey';
		case 'policy_ask':
			return 'shared.sealComposer.unsealedPrompt.policyAsk';
		case 'flag_off':
			return 'shared.sealComposer.unsealedPrompt.flagOff';
		case 'key_changed':
			return 'shared.sealComposer.unsealedPrompt.keyChanged';
	}
}

/**
 * Derive the unsealed-send confirmation prompt for a seal state, or `null` when
 * plaintext is not the sender's to choose: `willSeal` needs no decision,
 * `keyChanged` must be resolved on the thread first (never bypassable), and
 * `no_recipients` has no send to confirm. Mirrors `allowSendUnsealed` exactly, so
 * a lock that offers the control always has a prompt behind it.
 */
export function deriveUnsealedPrompt(state: SealState | null): UnsealedSendPrompt | null {
	if (!state || state.kind !== 'cannotSeal' || state.reason === 'no_recipients') return null;
	return {
		title: 'shared.sealComposer.unsealedPrompt.title',
		description: unsealedPromptDescription(state.reason),
		confirmLabel: 'shared.sealComposer.unsealedPrompt.confirm',
		cancelLabel: 'shared.sealComposer.unsealedPrompt.cancel',
	};
}
