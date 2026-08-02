/**
 * THE RELAY-REMOVAL GUARD — is this draft about to disconnect the relay, and
 * what does that cost this deployment?
 *
 * Lifted out of the transport editor because it is not editor logic: it is the
 * Independence screen's removal-safety read (`getIndependenceSummary`) asked a
 * second time from the screen where the change is actually made, so the two
 * cannot disagree about which cells are still leaning on the relay. The FACTS
 * are the server's, the WORDS are `relayRemovalConsequenceCopy`'s, and neither
 * is re-derived here.
 *
 * THE GUARD IS NOT WHAT MAKES THE CHANGE SAFE. `POST
 * /api/delivery/apply-transport` re-checks the typed phrase and refuses
 * fail-closed when it cannot establish that the removal is safe — which is
 * exactly the state this guard is in while the read is in flight, or after it
 * faulted. So a `false` here means "nothing known to hold back", never "safe".
 */

import { computed, type ComputedRef, type Ref } from 'vue';
import { api } from '@owlat/api';
import {
	relayRemovalConsequenceCopy,
	type RelayRemovalConsequence,
} from '~/utils/deliverabilityRamp';

export interface RelayRemovalGuard {
	/**
	 * True only when this deployment is KNOWN to have a second arm that cells are
	 * KNOWN to still be leaning on, and the draft would pull it.
	 */
	readonly removesReferenceArm: ComputedRef<boolean>;
	/** The consequence sentence for the confirmation dialog. */
	readonly removalConsequence: ComputedRef<RelayRemovalConsequence>;
	/**
	 * How many cells THIS BROWSER'S read found still leaning on the relay, or
	 * `null` when that read did not answer. Exposed because it is the one thing
	 * that says whether {@link removalConsequence} carries figures at all: the
	 * endpoint makes its own, independent read, so a caller holding a refusal has
	 * to be able to tell a sentence with a cell count in it from the figure-free
	 * one this guard produces on a `null` — and on a `safe` that lost the race.
	 */
	readonly dependentCellCount: ComputedRef<number | null>;
}

/**
 * @param resultingProvider The transport the draft would leave live. Selecting
 * the built-in MTA is the only draft that disconnects anything — the same rule
 * the endpoint applies to the resulting env, so the dialog appears exactly when
 * the server would demand the phrase.
 */
export function useRelayRemovalGuard(resultingProvider: Readonly<Ref<string>>): RelayRemovalGuard {
	const { data: independence } = useOrganizationQuery(
		api.delivery.rampIndependence.getIndependenceSummary
	);

	const relayRemoval = computed(() => independence.value?.relayRemoval ?? null);

	/**
	 * Cells that would be moved onto the own server at once, or `null` while the
	 * read has not answered — which is NOT "no cells": the dialog can also be
	 * opened by the endpoint's fail-closed refusal, and the copy has to be honest
	 * about knowing nothing rather than claim zero.
	 */
	const dependentCells = computed<readonly string[] | null>(() => {
		const removal = relayRemoval.value;
		if (removal === null) return null;
		return removal.kind === 'safe' ? [] : removal.dependentCells;
	});

	const projectedSafeAt = computed<number | null>(() => {
		const removal = relayRemoval.value;
		return removal === null || removal.kind === 'safe' ? null : removal.projectedSafeAt;
	});

	const referenceTransportId = computed<string | null>(
		() => independence.value?.referenceTransportId ?? null
	);

	return {
		removesReferenceArm: computed(
			() =>
				resultingProvider.value === 'mta' &&
				referenceTransportId.value !== null &&
				relayRemoval.value?.kind === 'unsafe'
		),
		removalConsequence: computed(() =>
			relayRemovalConsequenceCopy({
				dependentCells: dependentCells.value,
				referenceTransportId: referenceTransportId.value,
				projectedSafeAt: projectedSafeAt.value,
			})
		),
		dependentCellCount: computed(() => dependentCells.value?.length ?? null),
	};
}
