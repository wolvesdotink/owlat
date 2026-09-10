/**
 * Closed string unions that a table definition shares with the functions that
 * read and write it. One spelling per vocabulary, so a new member is a
 * one-place change and the stored shape and the argument shape cannot drift.
 * Composite validators (objects, records, catalog-derived unions) live in
 * `convexValidators.ts`.
 */

import { v } from 'convex/values';

/** Outcome of a one-shot run (backup, system update). */
export const successOrFailedValidator = v.union(v.literal('success'), v.literal('failed'));

/** Why an address is on the block list. */
export const blockReasonValidator = v.union(
	v.literal('bounced'),
	v.literal('complained'),
	v.literal('manual')
);

/** Health of a sending component (channel config, provider route). */
export const healthStatusValidator = v.union(
	v.literal('healthy'),
	v.literal('degraded'),
	v.literal('down')
);

/** The `agentMetrics` series a health query can ask for. */
export const agentMetricTypeValidator = v.union(
	v.literal('queue_depth'),
	v.literal('processing_latency'),
	v.literal('classification_accuracy'),
	v.literal('auto_approve_ratio'),
	v.literal('rejection_rate'),
	v.literal('llm_cost'),
	v.literal('error_rate')
);

export const chatRoomVisibilityValidator = v.union(v.literal('public'), v.literal('private'));
export const chatMemberRoleValidator = v.union(v.literal('admin'), v.literal('member'));

/** Verification state of a relay identity (`relayIdentities.status` and its observers). */
export const relayIdentityStatusValidator = v.union(
	v.literal('unverified'),
	v.literal('pending_dns'),
	v.literal('verified'),
	v.literal('failed')
);

/** How much of the briefing context the pipeline could afford for a step. */
export const contextTierValidator = v.union(
	v.literal('normal'),
	v.literal('compacted'),
	v.literal('emergency')
);

/** Antivirus verdict on an inbound message; `skipped` is "scanner not run". */
export const virusVerdictValidator = v.union(
	v.literal('clean'),
	v.literal('infected'),
	v.literal('skipped')
);

/** Lifecycle of a resumable mailbox job (import, semantic index, filter backfill). */
export const mailJobStatusValidator = v.union(
	v.literal('running'),
	v.literal('completed'),
	v.literal('cancelled'),
	v.literal('failed')
);

/** Delivery lifecycle of one send row (`emailSends`, `transactionalSends`). */
export const sendStatusValidator = v.union(
	v.literal('queued'),
	v.literal('sent'),
	v.literal('failed'),
	v.literal('delivered'),
	v.literal('opened'),
	v.literal('clicked'),
	v.literal('bounced'),
	v.literal('complained')
);

/** Which composer surface asked for a draft revision. */
export const draftSurfaceValidator = v.union(v.literal('compose'), v.literal('review'));

/** Which surface asked a clarification question or captured its answer. */
export const clarificationSourceValidator = v.union(v.literal('agent'), v.literal('reply_queue'));

export const mailCategoryLabelValidator = v.union(
	v.literal('person'),
	v.literal('newsletter'),
	v.literal('notification'),
	v.literal('receipt'),
	v.literal('other')
);
/** Who assigned a mail category; `user` overrides the classifiers. */
export const mailCategorySourceValidator = v.union(
	v.literal('heuristic'),
	v.literal('llm'),
	v.literal('user')
);

export const archiveFormatValidator = v.union(v.literal('mbox'), v.literal('eml'));

/** Where a semantic file came from. */
export const semanticFileSourceTypeValidator = v.union(
	v.literal('upload'),
	v.literal('email_attachment'),
	v.literal('agent_generated')
);

/** Value type of a user-defined field (contact property, data variable). */
export const fieldTypeValidator = v.union(
	v.literal('string'),
	v.literal('number'),
	v.literal('boolean'),
	v.literal('date')
);
