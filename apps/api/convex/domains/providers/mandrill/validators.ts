/**
 * The Mandrill identity's WIRE shape — one declaration, used by every Convex
 * boundary it crosses.
 *
 * The payload travels action → mutation twice (the lifecycle's
 * `registering → pending` callback and the relay sweep's store mutation), and a
 * validator copied into each of them is two places a new field has to be
 * remembered — with the failure landing at run time, on a callback that has
 * already created the identity at Mandrill. The type in `../types.ts` stays the
 * documented one; the assertion at the bottom keeps the two from drifting.
 */

import { v, type Infer } from 'convex/values';
import type { MandrillIdentity } from '../types';

export const mandrillIdentityValidator = v.object({
	kind: v.literal('mandrill'),
	dkimSelector: v.string(),
	status: v.union(
		v.literal('unverified'),
		v.literal('pending_dns'),
		v.literal('verified'),
		v.literal('failed')
	),
	spf: v.object({ isValid: v.boolean(), error: v.optional(v.string()) }),
	dkim: v.object({ isValid: v.boolean(), error: v.optional(v.string()) }),
	isValidSigning: v.boolean(),
	verifiedAt: v.optional(v.number()),
	verifyTxtKey: v.optional(v.string()),
	checkedAt: v.number(),
});

/** Compile-time proof that the validator and the documented type agree. */
export type _MandrillIdentityWireMatchesType =
	Infer<typeof mandrillIdentityValidator> extends MandrillIdentity
		? MandrillIdentity extends Infer<typeof mandrillIdentityValidator>
			? true
			: never
		: never;
