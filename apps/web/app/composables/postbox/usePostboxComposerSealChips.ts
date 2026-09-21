/**
 * The envelope half of per-recipient seal state (plan idea 11): which chips may
 * show a key glyph, and what "remove this blocker" actually does.
 *
 * Two decisions live here, both of them about not over-claiming:
 *
 *   - The chips get the per-recipient verdicts ONLY for the aggregate states
 *     that turn on recipient keys (`showsRecipientSealGlyphs`). Under an
 *     `off`/`ask` policy, a missing signing key or a dead feature flag, a lock
 *     beside a name would imply an encryption that is not going to happen, so
 *     the chips are handed nothing and stay silent.
 *   - Removing a named blocker is a RECIPIENT-LIST EDIT, not a consent path.
 *     The server recomputes the seal state from the shorter list; plaintext
 *     still requires the unsealed prompt. It drops the address from To, Cc and
 *     Bcc alike, because the blocker set is derived from all three together.
 *
 * Extracted from PostboxComposer.vue to keep that surface focused (and under
 * the file-size cap) — the composer just spreads the returned pair.
 */

import { computed, type Ref } from 'vue';
import { canonicalEmailAddress } from '~/utils/recipientHints';
import type { SealState } from '~/utils/sealComposer';
import { showsRecipientSealGlyphs, type RecipientSealView } from '~/utils/sealRecipients';

/** The bits of the seal-lock facade this needs; keeps the two loosely coupled. */
interface SealFacade {
	enabled: boolean;
	state: SealState | null;
	recipients: RecipientSealView[];
}

export function usePostboxComposerSealChips(
	seal: SealFacade,
	fields: {
		toAddresses: Ref<string[]>;
		ccAddresses: Ref<string[]>;
		bccAddresses: Ref<string[]>;
	}
) {
	const chipSealStates = computed<RecipientSealView[]>(() =>
		seal.enabled && showsRecipientSealGlyphs(seal.state) ? seal.recipients : []
	);

	function removeSealBlocker(address: string) {
		const canon = canonicalEmailAddress(address);
		const without = (list: string[]) => list.filter((a) => canonicalEmailAddress(a) !== canon);
		fields.toAddresses.value = without(fields.toAddresses.value);
		fields.ccAddresses.value = without(fields.ccAddresses.value);
		fields.bccAddresses.value = without(fields.bccAddresses.value);
	}

	return { chipSealStates, removeSealBlocker };
}
