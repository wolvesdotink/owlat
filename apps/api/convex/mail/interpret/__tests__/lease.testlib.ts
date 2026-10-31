/**
 * Calling the reducer directly the way a run does (lease.ts): a
 * source with a snapshot row commits only with its current lease token, so
 * a test that drives `applyInterpretation` itself claims the lease first,
 * exactly like `runApply.withSourceLease`. A source without a row has no
 * lease to claim and commits as it is.
 */

import type { FunctionArgs } from 'convex/server';
import { internal } from '../../../_generated/api';
import type { Test } from './interpret.testlib';

type ApplyArgs = FunctionArgs<typeof internal.mail.interpret.reduce.applyInterpretation>;

/** `applyInterpretation` under a freshly claimed lease of `args.source`. */
export async function applyAsRun(t: Test, args: ApplyArgs) {
	const claim = await t.mutation(internal.mail.interpret.lease.claimSourceLease, {
		source: args.source,
	});
	if (claim.kind === 'busy' || claim.kind === 'done') {
		throw new Error(`applyAsRun: the source lease is ${claim.kind}`);
	}
	return t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		...args,
		...(claim.kind === 'claimed' ? { leaseToken: claim.token } : {}),
	});
}
