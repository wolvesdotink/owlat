/**
 * Closed unions that a table definition shares with the functions that
 * read and write it. One spelling per vocabulary, so a new member is a
 * one-place change and the stored shape and the argument shape cannot drift.
 * Composite validators (objects, records, catalog-derived unions) live in
 * `convexValidators.ts`.
 */

import { v } from 'convex/values';
import type { Infer } from 'convex/values';

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

/**
 * The one spelling of the verdict union. Re-spelled inline in three modules
 * before this existed, which is how a fourth member would have reached one of
 * them and not the others. Every API-side producer and consumer imports THIS;
 * the Vue reader, which cannot import from `convex/`, types its prop off
 * `Doc<'inboundMessages'>['virusVerdict']` from the generated data model, so it
 * is the same union there too.
 */
export type VirusVerdict = Infer<typeof virusVerdictValidator>;

/**
 * What attachment capture did with a received message's files.
 *
 * Absent means "no attachment leaves at all, or this message predates the
 * marker". Every OTHER outcome is spelled, because the silent ones are the
 * defect: a file that still lists and still downloads, next to nothing that
 * says the assistant never opened it, reads exactly like one that was indexed.
 *   · `indexed` — every captured part reached `semanticFiles.ingest`;
 *   · `skipped_budget` — the per-sender/global AI-ingest budget was exhausted;
 *   · `skipped_unscanned` — no CLEAN malware verdict, so nothing was fed to a
 *     model (see `inbox/inboundIngest.ts`);
 *   · `skipped_too_large` — a part was over `MAX_AI_INGEST_ATTACHMENT_BYTES`;
 *   · `skipped_unsupported` — the file-type allowlist refused a part.
 *
 * The last two are set whenever a part was skipped for that reason, even if
 * OTHER parts of the same message were indexed: "some of these you have not
 * read" is the honest line, and `indexed` next to an unread file is not.
 */
export const attachmentIndexingValidator = v.union(
	v.literal('indexed'),
	v.literal('skipped_budget'),
	v.literal('skipped_unscanned'),
	v.literal('skipped_too_large'),
	v.literal('skipped_unsupported')
);

export type AttachmentIndexing = Infer<typeof attachmentIndexingValidator>;

/**
 * How long the shared inbox keeps a received message's FILES — the sealed raw
 * `.eml` and the attachment blobs captured out of it. A CLOSED set, for the
 * same reason `mailTrashAutoPurgeDaysValidator` is one: an arbitrary day count
 * is a footgun. There is deliberately no `0`/"forever" member, because
 * unbounded storage is the defect the horizon exists to close, and ABSENT
 * means `DEFAULT_INBOUND_RAW_RETENTION_DAYS` rather than "keep forever".
 *
 * Convex validators must be literal, so the set is spelled out here and
 * asserted against `INBOUND_RAW_RETENTION_DAY_CHOICES` in
 * `maintenance/__tests__/inboundRetention.test.ts`.
 */
export const inboundRawRetentionDaysValidator = v.union(
	v.literal(30),
	v.literal(90),
	v.literal(180),
	v.literal(365)
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

/**
 * How this instance decides which desktop release a connected app is offered:
 * `latest` (newest cached release on the channel), `pinned` (exactly the
 * recorded version) or `paused` (nothing at all).
 */
export const desktopUpdateModeValidator = v.union(
	v.literal('latest'),
	v.literal('pinned'),
	v.literal('paused')
);

/** Which desktop release channel an instance follows; `prerelease` also admits `vX.Y.Z-rc.N` tags. */
export const desktopUpdateChannelValidator = v.union(v.literal('stable'), v.literal('prerelease'));

/** Which GitHub release line a cached desktop release came from (`v*` vs `desktop-v*`). */
export const desktopReleaseLineValidator = v.union(v.literal('unified'), v.literal('desktop'));
