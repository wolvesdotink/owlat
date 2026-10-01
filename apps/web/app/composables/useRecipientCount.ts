import { getCurrentScope, onScopeDispose, ref, watch } from 'vue';
import { api } from '@owlat/api';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

type CountAudience = NonNullable<
	FunctionArgs<typeof api.campaigns.audienceResolution.countRecipients>['audience']
>;
export type RecipientCount = FunctionReturnType<
	typeof api.campaigns.audienceResolution.countRecipients
>;

/** The part of a readout the send surfaces read. */
type CountReading = { eligible: number; completeness?: string } | null | undefined;

/**
 * Is this reading an "at least" number? A capped or budget-stopped enumeration
 * (the inline page of a big audience, or a first count's running total) is.
 * `suppression_truncated` is an over-count, not a lower bound, so it is not.
 */
export function isLowerBoundCount(count: CountReading): boolean {
	return (
		count?.completeness === 'candidate_capped' || count?.completeness === 'read_budget_exhausted'
	);
}

/**
 * The eligible count when it is exact, else `null` ("unknown"). What a surface
 * that acts on the size (send estimate, readiness note, confirmation threshold)
 * may use: a lower bound would understate the blast radius.
 */
export function exactEligibleCount(count: CountReading): number | null {
	return count?.completeness === 'exact' ? count.eligible : null;
}

/**
 * Whether the readout asks for the background exact count now: the inline page
 * stopped short and nothing counts this audience yet, or a running count
 * stalled / a finished one aged past its refresh window (`retryAfter`).
 */
export function wantsExactCount(count: RecipientCount, now: number): boolean {
	// A server one release behind returns no `background`; there is no job to ask for.
	const background = count.background as RecipientCount['background'] | undefined;
	if (!background) return false;
	if (background.status === 'unavailable') return true;
	if (background.status === 'counting' || background.status === 'complete') {
		return now >= background.retryAfter;
	}
	return false;
}

/** Longest single wait for a `retryAfter` re-check (setTimeout's own ceiling is ~24.8 days). */
const MAX_RECHECK_MS = 60 * 60_000;

/**
 * The campaign recipient readout for one audience (#916).
 *
 * `countRecipients` reads at most one bounded page per execution. For an
 * audience bigger than that it returns a lower bound and says no exact count
 * exists (`background.status === 'unavailable'`); this composable then asks the
 * backend to count it in bounded background steps, once per audience and
 * state (an audience that drops back to "unavailable" after any other reading,
 * because its definition changed or its job was abandoned, is asked again). The job is keyed by the audience definition on the server, so two
 * open wizards share one count, and the query switches to the job's running
 * and then exact totals on its own.
 *
 * A reading with a future `retryAfter` is checked again at that instant even
 * if the data never changes, so a count that stalled (no more steps, so no
 * rerun) or aged past its refresh window is re-requested while the page stays
 * open.
 */
export function useRecipientCount(audience: () => CountAudience | null | undefined) {
	const { data } = useOrganizationQuery(api.campaigns.audienceResolution.countRecipients, () => ({
		audience: audience() ?? undefined,
	}));
	const convex = useConvex();
	const asked = new Set<string>();
	const recheck = ref(0);
	let timer: ReturnType<typeof setTimeout> | null = null;

	const clearTimer = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	if (getCurrentScope()) onScopeDispose(clearTimer);

	watch(
		[data, recheck],
		([count]) => {
			clearTimer();
			const current = audience();
			if (!count || !current || !convex) return;
			// A server one release behind returns no `background`: no job to ask for.
			const background = count.background as RecipientCount['background'] | undefined;
			if (!background) return;
			// An "unavailable" reading is asked about once. Any other reading means
			// the server has (or no longer needs) a count for that state, so a later
			// "unavailable" is new: the definition was edited, or the job row was
			// abandoned or cleaned up. Forget the old ask so it is requested again.
			if (background.status !== 'unavailable') {
				for (const token of asked) {
					if (JSON.parse(token)[1] === 'unavailable') asked.delete(token);
				}
			}
			const now = Date.now();
			if (!wantsExactCount(count, now)) {
				if ('retryAfter' in background) {
					const wait = Math.min(background.retryAfter - now + 1_000, MAX_RECHECK_MS);
					timer = setTimeout(() => {
						timer = null;
						recheck.value += 1;
					}, wait);
				}
				return;
			}
			const token = JSON.stringify([
				current,
				background.status,
				'retryAfter' in background ? background.retryAfter : null,
			]);
			if (asked.has(token)) return;
			asked.add(token);
			// Idempotent on the server; a failed request may be asked again.
			convex
				.mutation(api.campaigns.audienceCountJob.request, { audience: current })
				.catch(() => asked.delete(token));
		},
		{ immediate: true }
	);

	return data;
}
