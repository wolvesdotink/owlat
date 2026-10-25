/**
 * The deliverability seed-probe sweep (`analytics/seedProbePoller`,
 * `analytics/seedPlacement`): which seed mailboxes have probes to look for, and
 * where each probe was found.
 */

import { DESTINATION_PROVIDER_KEYS } from '@owlat/shared/deliverabilityRouting';
import { SEED_PLACEMENTS } from '@owlat/shared/seedPlacement';
import { v, type Infer } from 'convex/values';
import { defineEndpoint } from '../contract';
import { literalUnion } from '../literalUnion';

/**
 * One seed mailbox's outstanding probe work. Carries no credential and nothing
 * from inside a mailbox: an address the worker must connect to, and opaque
 * probe ids to look for.
 */
export const seedProbeWorkItemValidator = v.object({
	organizationId: v.string(),
	accountId: v.id('externalMailAccounts'),
	address: v.string(),
	provider: literalUnion(DESTINATION_PROVIDER_KEYS),
	/** Probes dispatched, settled, and still unclassified. */
	probeIds: v.array(v.string()),
	/** Probes past the give-up horizon — report MISSING without searching. */
	expiredProbeIds: v.array(v.string()),
	/**
	 * The ONLY hosts the hygiene click may be issued against — this deployment's
	 * own tracking/site origins. The click target is chosen from links found
	 * inside a message sitting in a mailbox we do not control the server of, so
	 * the allowed set is supplied by the backend rather than inferred from the
	 * content. An empty list means "click nothing".
	 */
	clickHosts: v.array(v.string()),
});
export type SeedProbeWorkItem = Infer<typeof seedProbeWorkItemValidator>;

/**
 * One PAGE of seed work. The sweep is cursored rather than a bounded top-N: a
 * fixed page with no cursor starves whichever organizations sort last on a
 * multi-org deployment, permanently and silently. The worker holds `cursor`
 * between ticks and starts over when the sweep reports `isDone`.
 */
export const listSeedProbeWork = defineEndpoint({
	path: 'analytics/seedProbePoller:listSeedProbeWork',
	kind: 'query',
	args: { now: v.number(), cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.object({
		items: v.array(seedProbeWorkItemValidator),
		cursor: v.union(v.string(), v.null()),
		isDone: v.boolean(),
	}),
});
export type SeedProbeWorkPage = Infer<typeof listSeedProbeWork.returns>;

/**
 * Report one probe's folder (`folderName: null` when every folder was walked
 * and it was not found). A refusal names its reason so the worker can tell
 * "not yours" (loud) from "gone" or "already done" (expected).
 */
export const recordSeedProbeClassification = defineEndpoint({
	path: 'analytics/seedPlacement:recordSeedProbeClassification',
	kind: 'mutation',
	args: {
		organizationId: v.string(),
		probeId: v.string(),
		folderName: v.union(v.string(), v.null()),
		/**
		 * The folder's RFC 6154 SPECIAL-USE attribute (`\Junk`, `\Trash`) when the
		 * server advertised one. It DECIDES ahead of the folder name: names are
		 * localized per account language, and an unrecognised name falls through to
		 * `category`, which counts as reached.
		 */
		specialUse: v.optional(v.string()),
		now: v.number(),
		/** Uniform [0,1) draw for the occasional click. Randomness stays at the edge. */
		clickRoll: v.number(),
	},
	returns: v.union(
		v.object({
			recorded: v.literal(false),
			reason: v.union(
				v.literal('unknown_probe'),
				v.literal('foreign_organization'),
				v.literal('never_dispatched'),
				v.literal('already_classified')
			),
		}),
		v.object({
			recorded: v.literal(true),
			placement: literalUnion(SEED_PLACEMENTS),
			hygiene: v.object({ markRead: v.boolean(), click: v.boolean() }),
		})
	),
});
