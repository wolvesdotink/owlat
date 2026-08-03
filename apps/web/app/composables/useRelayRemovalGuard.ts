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

import { computed, ref, type ComputedRef, type Ref } from 'vue';
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
	/** This browser's own consequence copy — the safe date is read off it. */
	readonly removalConsequence: ComputedRef<RelayRemovalConsequence>;
	/** The sentence the dialog shows: whichever read actually has figures. */
	readonly dialogConsequence: ComputedRef<string>;
	/**
	 * Hand over the consequence the ENDPOINT quoted when it refused, or `null` to
	 * forget it. Every apply attempt re-derives its own: a sentence kept from the
	 * previous one would be quoted at an operator whose deployment has moved on.
	 */
	noteServerRefusal(consequence: string | null): void;
}

/**
 * NO PROVIDER, IN EITHER VOCABULARY. `apply-transport` gates on the resulting
 * `EMAIL_PROVIDER` VALUE, where "none" is the empty string (trimmed); the
 * screens hold a `ProviderChoice`, whose word for it is `none` — which
 * `buildProviderEnv` turns into an OMITTED key and `planTransportEnvChange` then
 * deletes from the merged env, arriving at the endpoint as exactly that empty
 * value. Both spellings therefore end at the same refusal, so both open the
 * dialog: a caller handing over its own draft choice must not be the one that
 * has to translate.
 */
const NO_PROVIDER = new Set(['', 'none']);

/**
 * @param resultingProvider The transport the draft would leave live, as either
 * the resulting `EMAIL_PROVIDER` value or the screens' own `ProviderChoice`. A
 * result of the built-in MTA — or of no provider at all — is a deployment
 * sending on its own, and nothing else disconnects anything: that is
 * `apply-transport`'s rule on the resulting env, so the dialog appears exactly
 * when the server would demand the phrase. No shipped screen offers a
 * provider-less transport edit today; the predicates still have to agree,
 * because one that stops agreeing drifts silently.
 */
export function useRelayRemovalGuard(resultingProvider: Readonly<Ref<string>>): RelayRemovalGuard {
	const { data: independence } = useOrganizationQuery(
		api.delivery.rampIndependence.getIndependenceSummary
	);

	const relayRemoval = computed(() => independence.value?.relayRemoval ?? null);

	/**
	 * Cells that would be moved onto the own server at once, `[]` when the read
	 * answered that every cell has graduated, and `null` while it has not answered
	 * at all — which is NOT "no cells": the dialog can also be opened by the
	 * endpoint's fail-closed refusal, and the copy has to be honest about knowing
	 * nothing rather than claim zero.
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

	const localConsequence = computed(() =>
		relayRemovalConsequenceCopy({
			dependentCells: dependentCells.value,
			referenceTransportId: referenceTransportId.value,
			projectedSafeAt: projectedSafeAt.value,
		})
	);

	/**
	 * The consequence the SERVER quoted when it refused, kept verbatim.
	 *
	 * The two removal reads are independent — this composable's live subscription
	 * and the endpoint's own HTTP query — so the server routinely knows what the
	 * browser does not, and its refusal already names the cell count and the
	 * projected safe date. Dropping it left the dialog saying the situation could
	 * not be established on the one action that cannot be undone, while the answer
	 * sat unread in the response.
	 */
	const serverConsequence = ref<string | null>(null);

	return {
		removesReferenceArm: computed(() => {
			const resulting = resultingProvider.value.trim();
			return (
				(resulting === 'mta' || NO_PROVIDER.has(resulting)) &&
				referenceTransportId.value !== null &&
				relayRemoval.value?.kind === 'unsafe'
			);
		}),
		removalConsequence: localConsequence,
		/**
		 * LOCAL COPY WHEN IT HAS FIGURES, THE REFUSAL'S OTHERWISE. The local read
		 * has no cells to count in two states: it never answered, and it answered
		 * `safe` a moment before the server's read found four cells still leaning on
		 * the relay. Both are the state where the refusal is the only sentence with
		 * numbers in it, and on the second one the local sentence is worse than
		 * figure-free — it would tell an operator nothing is leaning on the relay
		 * inside the dialog the server opened by refusing. The local copy is
		 * preferred when it HAS figures because it is a computed off the live query:
		 * it keeps improving as the read advances, and a captured string cannot.
		 */
		dialogConsequence: computed(() => {
			const local = localConsequence.value.consequence;
			if ((dependentCells.value?.length ?? 0) > 0) return local;
			return serverConsequence.value ?? local;
		}),
		noteServerRefusal(consequence: string | null): void {
			serverConsequence.value = consequence;
		},
	};
}
