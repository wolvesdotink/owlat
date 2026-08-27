/**
 * Per-recipient seal state on the composer's chips (plan idea 11).
 *
 * The seal lock renders ONE aggregate verdict. With five recipients and a
 * `recipient_no_key` block, that verdict tells the sender that encryption is
 * off but not who is preventing it — so the only move left is sending
 * everything in plaintext. The per-recipient discovery states were already
 * computed server-side; `api.mail.drafts.getComposerSealState` now hands them
 * over (`toRecipientSealViews` — public trust only, never key material) and
 * this module turns them into what a chip may say.
 *
 * Two rules keep this presentational layer from over-claiming, and both are
 * unit-tested:
 *
 *   1. A chip glyph describes THE RECIPIENT'S KEY, never the message's fate.
 *      "Has a sealing key" is not "this will be sealed": the org policy, the
 *      sender's own signing key, or another recipient can still force
 *      plaintext. So the glyphs only render for the verdicts that actually turn
 *      on recipient keys ({@link showsRecipientSealGlyphs}) — under
 *      `policy_off`, `policy_ask`, `no_signing_key` or `flag_off` a green lock
 *      on a chip would be a lie of emphasis, and nothing is drawn.
 *   2. Naming the blockers is an EXPLANATION plus a way to remove a recipient.
 *      It is not a second route to plaintext: `deriveComposerLock` is untouched,
 *      the unsealed-send prompt remains the only consent path, and removing a
 *      recipient simply re-runs the server's own derivation on a shorter list.
 *      No silent downgrade is added or weakened here.
 *
 * Module scope, so no `useI18n`: every copy field is a catalog KEY (or a
 * `{ key, params }` pair), resolved with `t()` at the render boundary — the same
 * contract `sealComposer.ts` uses.
 */

import type { SealLockText, SealState } from './sealComposer';
import type { SealTone } from './sealTone';

/** Web mirror of the Convex `RecipientKeyOutcome` (`mail/sealPolicy.ts`). */
export type RecipientKeyOutcome = 'trusted' | 'keyChanged' | 'notFound' | 'missing';

/**
 * Web mirror of the Convex `RecipientSealView`. `hasUsableKey` is the server's
 * own "can we seal to this address?" predicate — NOT re-derived from `outcome`
 * here, because a `trusted` row whose pinned public key is missing is keyless as
 * far as dispatch is concerned, and a chip that reasoned from the outcome alone
 * would draw a lock the send would not honour.
 */
export interface RecipientSealView {
	address: string;
	outcome: RecipientKeyOutcome;
	hasUsableKey: boolean;
}

/** What one chip renders about its recipient's key. */
export interface RecipientSealGlyph {
	/** Discriminator, carried through for styling and test assertions. */
	kind: 'sealed' | 'keyChanged' | 'noKey';
	icon: string;
	tone: SealTone;
	/** Hover/assistive sentence — a catalog key plus the address it names. */
	title: SealLockText;
}

/**
 * Whether per-recipient glyphs may render for this aggregate verdict at all.
 *
 * True only when the recipients' keys are what the verdict turns on: sealing is
 * on and ready (`willSeal`), a recipient's key rotated (`keyChanged`), or a
 * recipient has no usable key (`recipient_no_key`). Every other `cannotSeal`
 * reason is about the org policy, the flag or the sender's own signing key —
 * marking chips there would answer a question nobody asked, and a lock glyph
 * would suggest an encryption that is not going to happen.
 */
export function showsRecipientSealGlyphs(state: SealState | null): boolean {
	if (!state) return false;
	if (state.kind === 'willSeal' || state.kind === 'keyChanged') return true;
	return state.reason === 'recipient_no_key';
}

/**
 * The glyph for ONE recipient. `keyChanged` outranks the usable-key check: a
 * rotated key must read as the specific warning it is, not as a generic "no
 * key", and never as a lock — the pinned material is exactly what is in doubt.
 */
export function recipientSealGlyph(recipient: RecipientSealView): RecipientSealGlyph {
	if (recipient.outcome === 'keyChanged') {
		return {
			kind: 'keyChanged',
			icon: 'lucide:key-round',
			tone: 'warn',
			title: {
				key: 'shared.sealRecipients.keyChangedTitle',
				params: { address: recipient.address },
			},
		};
	}
	if (recipient.hasUsableKey) {
		return {
			kind: 'sealed',
			icon: 'lucide:lock',
			tone: 'ok',
			title: { key: 'shared.sealRecipients.hasKeyTitle', params: { address: recipient.address } },
		};
	}
	return {
		kind: 'noKey',
		icon: 'lucide:lock-open',
		tone: 'muted',
		title: { key: 'shared.sealRecipients.noKeyTitle', params: { address: recipient.address } },
	};
}

/** Case-insensitive lookup of a chip's recipient in the draft's seal states. */
export function findRecipientSealView(
	recipients: RecipientSealView[],
	address: string
): RecipientSealView | null {
	const canon = address.trim().toLowerCase();
	return recipients.find((r) => r.address.trim().toLowerCase() === canon) ?? null;
}

/**
 * The addresses whose missing key is why this draft cannot be sealed — the ones
 * the banner names, each with a remove affordance.
 *
 * ONLY for `recipient_no_key`. A `keyChanged` draft is deliberately excluded:
 * that state is resolved by re-accepting the new key on the conversation (the
 * lock's own copy says so and already names the rotated addresses), and turning
 * it into a "remove this person" button would quietly reframe a security
 * decision as a recipient-list edit. Empty for every other verdict.
 */
export function sealBlockingRecipients(
	state: SealState | null,
	recipients: RecipientSealView[]
): string[] {
	if (!state || state.kind !== 'cannotSeal' || state.reason !== 'recipient_no_key') return [];
	return recipients.filter((r) => !r.hasUsableKey).map((r) => r.address);
}
