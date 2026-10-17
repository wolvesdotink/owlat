/**
 * Read on arrival: the cross-lane hooks (SPEC §2.9). Each hook has a stable
 * signature that its call sites build against, a no-op stub, and an owning
 * lane that replaces the stub with the real implementation.
 *
 * `ARRIVAL_HOOK_STUBS` names every hook that is still a stub. An owning lane
 * removes its hook's name when it lands the implementation; the final wiring
 * gate (SPEC §9) fails while the set is not empty.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Placement } from '@owlat/shared/arrival';
import type { Doc, Id } from '../../_generated/dataModel';
import type { ActionCtx, MutationCtx, QueryCtx } from '../../_generated/server';
import type { InboundOrigin } from '../deliveryPipeline/insert';
import { applySenderStatus, countSenderDelivery } from '../senders/delivery';
import { countFirstOpen } from '../senders/opens';
import type { ManualPassOutcome } from '../deliveryPipeline/routing';
import {
	applyRuleAnswers,
	listPendingRuleQuestions,
	runArrivalRulesPass,
} from '../rules/rulesPass';
import type { ArrivalRecordSeed } from './records';

/** The live ingest origins (hosted MX, forward sync). Never a history import. */
export type LiveInboundOrigin = Exclude<InboundOrigin, 'backfill'>;

/** An AI-conditioned filter waiting for the R2 answer bound to one message (§6.2). */
export interface PendingAiFilter {
	filterId: Id<'mailFilters'>;
	revision: number;
	question: string;
}

/** One R2 answer; `null` is unknown or failed and counts as no match. */
export interface ArrivalAiAnswer {
	filterId: Id<'mailFilters'>;
	revision: number;
	answer: boolean | null;
}

export interface EvaluateArrivalRulesArgs {
	message: Doc<'mailMessages'>;
	mailboxId: Id<'mailboxes'>;
	origin: LiveInboundOrigin;
	/**
	 * Hosted MX only: what the manual pre-insert pass applied (its exclusive
	 * winners) and where it stopped processing. External sync has no manual pass.
	 */
	manualPass?: ManualPassOutcome;
}

export interface EvaluateArrivalRulesResult {
	/** Written to the message's arrival record; ≤5, highest priority first. */
	pendingAiFilters: PendingAiFilter[];
	/** From a matched placement/digest rule action. */
	rulePlacement?: Placement;
	/** The `archiveAfter` rows the pass created. */
	delayedActions: Id<'mailDelayedActions'>[];
	/** The record's other rule fields, written with it (§6.2). */
	exclusiveWinners?: ArrivalRecordSeed['exclusiveWinners'];
	filterMatches?: ArrivalRecordSeed['filterMatches'];
	lastOperationId?: Id<'mailArrivalOperations'>;
}

/**
 * The delivery input of sender-status enforcement. On hosted MX it runs
 * before the insert (right after `resolveFilterOutcome`), so there is no
 * message row yet; on external sync it runs after `insertDeliveredMessage`
 * and names the row.
 */
export interface SenderDeliveryInput {
	mailboxId: Id<'mailboxes'>;
	/** The From address as delivered (`Name <a@b>` or bare). */
	fromAddress: string;
	origin: LiveInboundOrigin;
	/** A user filter already moved, trashed or discarded it: status does nothing. */
	isMovedByFilter: boolean;
	/** External sync: the inserted row. */
	messageId?: Id<'mailMessages'>;
}

/** What sender status did at delivery; null when it did nothing (§5). */
export type SenderStatusAtDelivery = {
	status: Doc<'mailSenderProfiles'>['status'];
	filedTo?: 'archive';
} | null;

/**
 * Lane rules (SPEC §6.2). The plain-language / Fix-origin and AI-conditioned
 * filter pass, called once from each live-ingest path (`mail/delivery.ts`,
 * `mail/external/delivery.ts`) right after `insertDeliveredMessage`. Never
 * called for history imports or backfill. Implemented in
 * `mail/rules/rulesPass.ts runArrivalRulesPass`; the result goes to
 * `runPostInsertInboundEffects({ arrival })`, which seeds the record with it.
 */
export async function evaluateArrivalRules(
	ctx: MutationCtx,
	args: EvaluateArrivalRulesArgs
): Promise<EvaluateArrivalRulesResult> {
	return await runArrivalRulesPass(ctx, args);
}

/**
 * Lane rules (SPEC §6.2). The pending AI questions of ONE message, read from
 * its arrival record's `pendingAiFilters`; R2 (`categoryClassify`) asks them.
 * Implemented in `mail/rules/rulesPass.ts listPendingRuleQuestions`.
 */
export async function listArrivalAiQuestions(
	ctx: Pick<QueryCtx, 'db'>,
	args: { mailboxId: Id<'mailboxes'>; messageId: Id<'mailMessages'> }
): Promise<PendingAiFilter[]> {
	return await listPendingRuleQuestions(ctx, args);
}

/**
 * Lane rules (SPEC §6.2). Apply R2's answers for ONE message: revision-checked,
 * restrict-only, subject to `exclusiveWinners`, logged as a `rule_apply`
 * operation in the same mutation, then the projection is refreshed.
 * Implemented in `mail/rules/rulesPass.ts applyRuleAnswers`.
 */
export async function applyArrivalAiAnswers(
	ctx: MutationCtx,
	args: { messageId: Id<'mailMessages'>; answers: ArrivalAiAnswer[] }
): Promise<void> {
	await applyRuleAnswers(ctx, args);
}

/**
 * Lane senders (SPEC §5). Sender-status enforcement at delivery, after user
 * filters: `unsubscribed` and `auto_archive` file to Archive, `digest` stays.
 * Implemented in `mail/senders/delivery.ts applySenderStatus` (the seam with
 * the arrival record is documented there).
 */
export async function applySenderStatusAtDelivery(
	ctx: MutationCtx,
	input: SenderDeliveryInput
): Promise<SenderStatusAtDelivery> {
	return await applySenderStatus(ctx, input);
}

/**
 * Lane senders (SPEC §5). Count a live delivery in the sender's profile
 * (delivered weeks, kind, last delivered). Ignores any non-live origin.
 * Implemented in `mail/senders/delivery.ts countSenderDelivery`; both live
 * paths reach it through `settleSenderDelivery`.
 */
export async function recordSenderDelivery(
	ctx: MutationCtx,
	args: { message: Doc<'mailMessages'>; origin: InboundOrigin }
): Promise<void> {
	await countSenderDelivery(ctx, args);
}

/**
 * Lane senders (SPEC §5). Count a message's first reader open in its sender's
 * opened weeks, once (`mailMessages.isOpenCounted`), for live mail only.
 * Implemented in `mail/senders/opens.ts countFirstOpen`.
 */
export async function recordFirstOpen(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>
): Promise<void> {
	await countFirstOpen(ctx, messageId);
}

/**
 * Lane rules / wiring (SPEC §4.2, §6.1). Compile the rule a person described
 * in Fix's optional "why" into its `mailRuleDrafts` row. Fix
 * (`mail/arrival/fix.ts`) writes the row (`status: 'compiling'`, origin `fix`,
 * `sourceText` sealed, `fromMessageId`) in the Fix mutation and schedules
 * `internal.mail.arrival.fixCompile.compile`, which calls this. It runs the
 * §6.1 compile (`mail/filterCompile.compileDraft`, the same model path as
 * `compile`, charged to the mailbox owner's background bucket) over that
 * draft and lands it `ready` (a draft rule waiting in Rules) or `failed`. It
 * never enables a rule: the person confirms the preview.
 */
export async function compileFixRuleDraft(
	_ctx: ActionCtx,
	_args: { draftId: Id<'mailRuleDrafts'> }
): Promise<void> {}

export type ArrivalHookName =
	| 'evaluateArrivalRules'
	| 'listArrivalAiQuestions'
	| 'applyArrivalAiAnswers'
	| 'applySenderStatusAtDelivery'
	| 'recordSenderDelivery'
	| 'recordFirstOpen'
	| 'compileFixRuleDraft';

/** The lane that owns each hook. */
export const ARRIVAL_HOOK_OWNERS: Readonly<Record<ArrivalHookName, 'rules' | 'senders'>> = {
	evaluateArrivalRules: 'rules',
	listArrivalAiQuestions: 'rules',
	applyArrivalAiAnswers: 'rules',
	applySenderStatusAtDelivery: 'senders',
	recordSenderDelivery: 'senders',
	recordFirstOpen: 'senders',
	compileFixRuleDraft: 'rules',
};

/** Hooks still stubbed. Remove a name when its implementation lands. */
export const ARRIVAL_HOOK_STUBS: ReadonlySet<ArrivalHookName> = new Set<ArrivalHookName>([
	'compileFixRuleDraft',
]);
