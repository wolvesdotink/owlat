import { v, type Validator } from 'convex/values';
import { DNSBL_LIST_IDS } from '@owlat/shared/dnsbl';
import { FCRDNS_FAILURE_REASONS, FCRDNS_VERDICTS } from '@owlat/shared/fcrdns';
import {
	DNSBL_STATUSES,
	IP_READINESS_BLOCK_REASONS,
	IPV6_SPF_FAILURE_REASONS,
	IPV6_SPF_VERDICTS,
	SOURCE_ADDRESS_FAILURE_REASONS,
	SOURCE_ADDRESS_VERDICTS,
} from '@owlat/shared/ipReadiness';

function literalUnion<const T extends readonly [string, ...string[]]>(values: T) {
	const [first, ...rest] = values;
	return v.union(v.literal(first), ...rest.map((value) => v.literal(value))) as Validator<
		T[number]
	>;
}

/** Readiness fields shared by the warming-state table and its sync mutation. */
export const ipReadinessFieldValidators = {
	blockReasons: v.optional(v.array(literalUnion(IP_READINESS_BLOCK_REASONS))),
	dnsblListings: v.optional(v.array(literalUnion(DNSBL_LIST_IDS))),
	dnsbl: v.optional(literalUnion(DNSBL_STATUSES)),
	fcrdns: v.optional(
		v.object({
			ehlo: v.string(),
			ptrNames: v.array(v.string()),
			isPtrPresent: v.boolean(),
			isPtrFqdn: v.boolean(),
			isForwardConfirmed: v.boolean(),
			isEhloMatched: v.boolean(),
			verdict: literalUnion(FCRDNS_VERDICTS),
			isGenericPtr: v.boolean(),
			reason: v.optional(literalUnion(FCRDNS_FAILURE_REASONS)),
			checkedAt: v.number(),
			isOverridden: v.boolean(),
		})
	),
	ipv6Spf: v.optional(
		v.object({
			domain: v.string(),
			verdict: literalUnion(IPV6_SPF_VERDICTS),
			reason: v.optional(literalUnion(IPV6_SPF_FAILURE_REASONS)),
			checkedAt: v.number(),
		})
	),
	sourceAddress: v.optional(
		v.object({
			verdict: literalUnion(SOURCE_ADDRESS_VERDICTS),
			reason: v.optional(literalUnion(SOURCE_ADDRESS_FAILURE_REASONS)),
			target: v.optional(v.string()),
			checkedAt: v.number(),
		})
	),
};
