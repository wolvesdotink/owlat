/**
 * Failure logging at the public function builders.
 *
 * Every public query, mutation and action is built by `lib/authedFunctions.ts`,
 * so that is the one seam where a failed invocation can be logged ONCE, with
 * the same shape, whatever the handler did: `function.<kind>.failed` with the
 * Operation-error `category`, the trusted `orgId` the auth floor resolved, and
 * `durationMs`. The original thrown value is rethrown untouched, so callers,
 * the client error mapping and Convex's own function log see exactly what they
 * saw before.
 *
 * Only the base builders wrap their handler. The composed ones
 * (`featureGated`, `featureGatedAny`, the platform-admin gates) hand their
 * handler to a base builder, so they are inside its boundary and a failure in
 * their gate is logged once, by the base builder, not twice.
 *
 * What this cannot see: Convex validates `args` before the handler runs, so an
 * argument-validator rejection never reaches this wrapper. Convex logs those
 * itself.
 *
 * Nothing from the error is logged but its category. A message or `data`
 * payload can quote mail content, an address or a token, and the category is
 * what an operator aggregates on; the message stays in Convex's own log.
 *
 * Queries are SAMPLED for expected categories. A subscribed query that starts
 * failing (a role was revoked, a record was deleted) is re-run by the client
 * on every invalidation, and one line per re-run would bury every other line.
 * `internal` failures (bugs, not outcomes) are always logged.
 *
 * `durationMs` is recorded for actions only. Convex holds the clock still for
 * the length of a query or mutation, so a duration there would always read 0,
 * and the authed read path is kept free of clock reads on purpose. Convex's
 * own function log carries the execution time of every invocation.
 */

import { extractOperationError, type OperationErrorCategory } from '@owlat/shared/operationError';
import { logEvent } from './runtimeLog';

export type InstrumentedFunctionKind = 'query' | 'mutation' | 'action';

/**
 * Filled in by a builder's auth floor once it has resolved the caller's org,
 * so a failure AFTER the floor is attributed to a trusted org and a failure IN
 * the floor (unauthenticated, not a member) carries none.
 */
export interface InvocationScope {
	orgId?: string;
}

/** One in ten expected query failures is logged; see the module comment. */
export const QUERY_FAILURE_SAMPLE_RATE = 0.1;

/**
 * Whether one failure is logged. Pure so the sampling rule is testable without
 * a random source: `draw` is a uniform value in [0, 1).
 */
export function shouldLogFailure(
	kind: InstrumentedFunctionKind,
	category: OperationErrorCategory,
	draw: number
): boolean {
	if (kind !== 'query' || category === 'internal') return true;
	return draw < QUERY_FAILURE_SAMPLE_RATE;
}

function reportFailure(
	kind: InstrumentedFunctionKind,
	error: unknown,
	scope: InvocationScope,
	durationMs: number | undefined
): void {
	const category = extractOperationError(error)?.category ?? 'internal';
	if (!shouldLogFailure(kind, category, Math.random())) return;
	logEvent(
		`function.${kind}.failed`,
		{
			orgId: scope.orgId,
			durationMs,
			outcome: 'failed',
			category,
			...(kind === 'query' && category !== 'internal'
				? { detail: { sampleRate: QUERY_FAILURE_SAMPLE_RATE } }
				: {}),
		},
		category === 'internal' ? 'error' : 'warn'
	);
}

/**
 * Wrap a builder's handler so a throw or a rejected promise is logged once and
 * rethrown as the same value. `run` receives the scope its floor fills in.
 */
export function logFailures<Ctx>(
	kind: InstrumentedFunctionKind,
	run: (ctx: Ctx, args: unknown, scope: InvocationScope) => unknown
): (ctx: Ctx, args: unknown) => Promise<unknown> {
	return async (ctx: Ctx, args: unknown) => {
		const scope: InvocationScope = {};
		const startedAt = kind === 'action' ? Date.now() : undefined;
		try {
			return await run(ctx, args, scope);
		} catch (error) {
			try {
				const durationMs = startedAt === undefined ? undefined : Date.now() - startedAt;
				reportFailure(kind, error, scope, durationMs);
			} catch {
				// Logging must never replace the failure it describes.
			}
			throw error;
		}
	};
}
