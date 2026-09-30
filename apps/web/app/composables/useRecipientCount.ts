import { watch } from 'vue';
import { api } from '@owlat/api';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

type CountAudience = NonNullable<
	FunctionArgs<typeof api.campaigns.audienceResolution.countRecipients>['audience']
>;
export type RecipientCount = FunctionReturnType<
	typeof api.campaigns.audienceResolution.countRecipients
>;

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

/**
 * The campaign recipient readout for one audience (#916).
 *
 * `countRecipients` reads at most one bounded page per execution. For an
 * audience bigger than that it returns a lower bound and says no exact count
 * exists (`background.status === 'unavailable'`); this composable then asks the
 * backend to count it in bounded background steps, once per audience and
 * state. The job is keyed by the audience definition on the server, so two
 * open wizards share one count, and the query switches to the job's running
 * and then exact totals on its own.
 */
export function useRecipientCount(audience: () => CountAudience | null | undefined) {
	const { data } = useOrganizationQuery(api.campaigns.audienceResolution.countRecipients, () => ({
		audience: audience() ?? undefined,
	}));
	const convex = useConvex();
	const asked = new Set<string>();

	watch(
		data,
		(count) => {
			const current = audience();
			if (!count || !current || !convex || !wantsExactCount(count, Date.now())) return;
			const background = count.background;
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
