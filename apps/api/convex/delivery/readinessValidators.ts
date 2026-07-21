import { v } from 'convex/values';

/** Readiness fields shared by the warming-state table and its sync mutation. */
export const ipReadinessFieldValidators = {
	blockReasons: v.optional(v.array(v.union(v.literal('dnsbl'), v.literal('fcrdns')))),
	dnsbl: v.optional(
		v.union(v.literal('unknown'), v.literal('clean'), v.literal('degraded'), v.literal('critical'))
	),
	fcrdns: v.optional(
		v.object({
			ehlo: v.string(),
			ptrNames: v.array(v.string()),
			isPtrPresent: v.boolean(),
			isPtrFqdn: v.boolean(),
			isForwardConfirmed: v.boolean(),
			isEhloMatched: v.boolean(),
			verdict: v.union(v.literal('pass'), v.literal('warn'), v.literal('fail'), v.literal('error')),
			isGenericPtr: v.boolean(),
			reason: v.optional(
				v.union(
					v.literal('no-ptr'),
					v.literal('ptr-not-fqdn'),
					v.literal('forward-mismatch'),
					v.literal('ehlo-mismatch'),
					v.literal('lookup-error')
				)
			),
			checkedAt: v.number(),
			isOverridden: v.boolean(),
		})
	),
};
