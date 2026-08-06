/**
 * THE DECLARED FEEDBACK ROUTE vs THE ROUTE THE BACKEND ACTUALLY REGISTERS.
 *
 * `providerFeedback.webhookPath` is a shared declaration (`@owlat/shared`) that
 * the delivery config page turns into the absolute endpoint an operator PASTES
 * INTO A PROVIDER CONSOLE — the one string on that card whose being wrong is
 * silent on our side and total on theirs: events stop arriving, and the only
 * symptom is a bounce rate that quietly goes to zero.
 *
 * `apps/api/convex/http.ts` registers each of those paths BY HAND, and it lives
 * in a different package from the declaration. The catalog suite pins the paths
 * as literals, which catches a change to the declaration; nothing caught a change
 * to the ROUTE. This suite is the cross-check between the two, walking the real
 * router rather than restating either side a third time.
 *
 * It runs here rather than in `packages/shared` because only this package may
 * import the Convex router — the same reason `credentialFieldVocabulary` lives
 * beside it. The generalised registry P2.1 builds needs exactly this guard.
 */
import { describe, expect, it } from 'vitest';
import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	type CoreSendProviderCatalogEntry,
} from '@owlat/shared';
import http from '../../../http';

/** `[path, method, handler]` triples, as `httpRouter().getRoutes()` returns them. */
type RegisteredRoute = [string, string, unknown];

const routes = (http as unknown as { getRoutes: () => RegisteredRoute[] }).getRoutes();
const registered = new Set(routes.map(([path, method]) => `${method} ${path}`));

// Widened to the entry TYPE rather than read off the literal's union, which
// narrows each member to the fields that one entry happens to declare.
const entries: readonly CoreSendProviderCatalogEntry[] = CORE_SEND_PROVIDER_CATALOG_ENTRIES;
const declaring = entries.filter((entry) => entry.providerFeedback !== undefined);

describe('every declared feedback route is a route the backend registers', () => {
	it('finds the router and its webhook routes at all', () => {
		// A guard on the guard: if `getRoutes()` ever stops answering, every
		// assertion below would pass vacuously against an empty set.
		expect(routes.length).toBeGreaterThan(0);
		expect(declaring.length).toBeGreaterThan(0);
	});

	it.each(declaring.map((entry) => [entry.kind, entry.providerFeedback!.webhookPath] as const))(
		'%s declares %s, and http.ts serves it',
		(_kind, path) => {
			expect([...registered]).toContain(`POST ${path}`);
		}
	);

	/**
	 * The other direction, which is the one that actually rots: a route added for
	 * a kind whose entry says nothing about feedback leaves the delivery page
	 * showing no panel and no endpoint, with everything green. Matched on the
	 * conventional `/webhooks/<kind>` shape — an EXACT match, so the MTA's
	 * sibling routes (`/webhooks/mta-mailbox`, `/webhooks/mta-tls-report`,
	 * `/webhooks/mta-verify-credential`) are not mistaken for its feedback route.
	 */
	it('has no unclaimed per-kind webhook route', () => {
		const unclaimed = entries
			.filter(
				(entry) =>
					registered.has(`POST /webhooks/${entry.kind}`) && entry.providerFeedback === undefined
			)
			.map((entry) => entry.kind);
		expect(unclaimed, 'these kinds have a webhook route but declare no providerFeedback').toEqual(
			[]
		);
	});

	it('declares the path a kind’s route actually has, not one derived from its name', () => {
		// The declaration exists so a kind RENAME cannot silently move a URL an
		// operator already pasted into a console. Today every path happens to match
		// its kind; the day one does not, this assertion is what has to be edited
		// deliberately rather than a URL that changes itself.
		for (const entry of declaring) {
			expect([entry.kind, entry.providerFeedback!.webhookPath]).toEqual([
				entry.kind,
				`/webhooks/${entry.kind}`,
			]);
		}
	});
});
