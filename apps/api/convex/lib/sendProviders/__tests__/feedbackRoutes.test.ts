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
 * router rather than restating either side a third time — plus one assertion the
 * router cannot answer, that each route is still WRITTEN OUT in `http.ts` rather
 * than generated from a kind.
 *
 * It runs here rather than in `packages/shared` because only this package may
 * import the Convex router — the same reason `credentialFieldVocabulary` lives
 * beside it. It is also what keeps the registry in `webhooks/adapters/` honest at
 * the one seam its mapped types cannot reach: those prove a declaring kind has an
 * adapter, this proves the declared PATH is a route. (The third leg — that the
 * route reaches THAT kind's adapter — is
 * `webhooks/__tests__/adapterRegistry.test.ts`.)
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

	/**
	 * THE ROUTE IS WRITTEN OUT, NOT GENERATED.
	 *
	 * Every assertion above walks `getRoutes()`, and a router built by
	 * `for (const kind of KINDS) http.route({ path: `/webhooks/${kind}`, … })`
	 * satisfies all of them — while making every one of these URLs a function of a
	 * kind's spelling. That is exactly the change this seam forbids: those URLs are
	 * already pasted into provider consoles we do not own, so a rename would move
	 * them, and a moved feedback URL is silent on our side and total on theirs.
	 *
	 * Only the SOURCE can say the difference, so this reads it. It lives here, in
	 * the package whose change would break it, rather than only in the docs suite —
	 * `scripts/ci-select-affected.sh` would not select `@owlat/docs` for an
	 * apps/api-only pull request, and an invariant a PR cannot fail is not a gate.
	 */
	it('writes each feedback route out as a literal in http.ts', () => {
		const source = readFileSync(
			resolve(dirname(fileURLToPath(import.meta.url)), '../../../http.ts'),
			'utf8'
		);
		// COMMENTS ARE STRIPPED FIRST. The natural shape of the refactor this
		// forbids is a loop over the registry with the four hand-written blocks
		// left commented out above it "for reference" — after which `getRoutes()`
		// still reports the same four paths and a containment check over the RAW
		// text still finds the four literals, in the comment. Every gate green,
		// every URL now a function of a kind's spelling. The line-comment pass
		// requires the `//` not to follow a `:`, so a `scheme://host` inside a
		// string survives it.
		const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
		for (const entry of declaring) {
			expect(code, `http.ts stopped writing out ${entry.providerFeedback!.webhookPath}`).toContain(
				`path: '${entry.providerFeedback!.webhookPath}'`
			);
		}
		// And the rule stated directly rather than only through its instances:
		// EVERY route path in the file is a written-out string literal. Four
		// surviving literals beside a generated fifth is the same defect, and the
		// loop above cannot see it — it only asks whether its own four are there.
		const derived = [...code.matchAll(/\bpath(?:Prefix)?:\s*(.)/g)].filter(
			(match) => match[1] !== "'" && match[1] !== '"'
		);
		expect(
			derived.map((match) => match[0]),
			'every route path in http.ts must be a written-out literal, never a template or a variable'
		).toEqual([]);
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
