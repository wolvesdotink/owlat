/**
 * Convex wiring for the composer seal-lock indicator (Sealed Mail E5, flag
 * `sealedMail`). Reads the honest per-draft seal state (auth, mailbox-scoped)
 * from `api.mail.drafts.getComposerSealState` so the lock's promise matches what
 * the sender actually does at dispatch. Only subscribes once the draft exists and
 * the flag is on; the query re-runs on the draft's row, so it recomputes as
 * recipients change.
 *
 * Extracted from PostboxComposer.vue to keep that surface focused (and under the
 * file-size cap) — the composer just reads `{ sealedMailEnabled, composerSealState }`.
 */

import { computed } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { SealState } from '~/utils/sealComposer';

export function usePostboxComposerSealLock(draftId: () => Id<'mailDrafts'> | undefined) {
	const { isEnabled } = useFeatureFlag();
	const sealedMailEnabled = computed(() => isEnabled('sealedMail'));

	const sealStateQuery = useConvexQuery(api.mail.drafts.getComposerSealState, () => {
		const id = draftId();
		return sealedMailEnabled.value && id ? { draftId: id } : ('skip' as const);
	});

	const composerSealState = computed(() => (sealStateQuery.data.value ?? null) as SealState | null);

	return { sealedMailEnabled, composerSealState };
}
