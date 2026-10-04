/**
 * Contact erasure — the ordered, budgeted steps that remove everything that
 * depends on one contact, as declared in `relations.ts`.
 *
 * Two drivers use the same steps, so the policy lives in one place:
 *   - the persisted walker (`walker.ts`) runs them a bounded transaction at a
 *     time, saving the phase and cursor it stopped at on the job row;
 *   - `permanentlyDeleteContactWithRelations` (lib/contactMutations.ts) runs
 *     them all inline, for callers that already work in small batches
 *     (organization wipe, sample-data removal).
 *
 * Every phase is idempotent and resumable: rows it deletes leave its read
 * range, parents go after their children, and the two phases that keep their
 * rows (scrubbed sends) page through them with a saved cursor.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Doc, Id, TableNames } from '../../_generated/dataModel';
import { decrementContactCount } from '../../lib/contactCountHelpers';
import { recordContactGrowth } from '../growthCounters';
import { deleteAutomationRun } from '../../automations/runDeletion';
import { internal } from '../../_generated/api';
import { deleteCompletionFailurePayload } from '../../delivery/sendCompletionFailures';
import { CONTACT_CLEANUP_BATCH_SIZE } from '../../delivery/sendCompletionFailureAdmin';
import type { ErasureBudget } from './budget';
import { CONTACT_ERASURE_PHASES, type ContactErasurePhase } from './phaseCatalog';
import {
	DONE,
	NOT_DONE,
	deleteAll,
	drainEach,
	drainParents,
	type ErasureMode,
	type PhaseContext,
	type PhaseOutcome,
	type PhaseRunner,
} from './phaseKit';
import {
	eraseConversationThreads,
	eraseFormSubmissions,
	eraseInboundMessages,
	eraseKnowledge,
	eraseSemanticFiles,
	eraseUnifiedMessages,
} from './contentPhases';

/** Sends scrubbed per page of the paginated send phases, before the byte bound. */
const SCRUB_PAGE = 128;

/**
 * Prefixed to a saved cursor when the page read from it came back cut short
 * (`SplitRequired`): the next transaction reads the same page again from that
 * cursor, sized for maximum-size rows, before going back to full pages.
 */
const NARROW_PAGE = 'narrow:';

/** Delete every row of one `by_contact`-style index range. */
function deleteByIndex(
	read: (phase: PhaseContext, limit: number) => Promise<Array<{ _id: Id<TableNames> }>>
): PhaseRunner {
	return async (phase) => ({ isDone: await deleteAll(phase, (n) => read(phase, n)) });
}

/**
 * Terminate and delete the contact's automation runs through the run lifecycle
 * (automations/runDeletion.ts), so the active totals stay right and no step run
 * outlives its run.
 */
const eraseAutomationRuns: PhaseRunner = async ({ ctx, contactId, budget }) => {
	// A run with a long history takes several `deleteAutomationRun` calls; keep
	// calling while the budget lasts (an unlimited inline budget drains it here)
	// rather than giving up after the first.
	while (!budget.isExhausted) {
		const run = await ctx.db
			.query('automationRuns')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.first();
		if (!run) return DONE;
		budget.chargeRead(run);
		// The helper reads the run again, then its step runs; `onRead` charges
		// each of those reads as it happens.
		const progress = await deleteAutomationRun(ctx, run._id, budget.chunk(256), (doc) =>
			budget.chargeRead(doc)
		);
		budget.chargeRows(progress.rowsTouched);
	}
	return NOT_DONE;
};

type SendTable = 'emailSends' | 'transactionalSends';

/** The address the scrub writes; a row carrying it has been erased already. */
const ERASED_ADDRESS = '[erased]';

function isErasedSend(send: Doc<'emailSends'> | Doc<'transactionalSends'>): boolean {
	return ('contactEmail' in send ? send.contactEmail : send.email) === ERASED_ADDRESS;
}

/**
 * Send rows are kept for statistics but soft-deleted and scrubbed of the
 * recipient's identity — erasure means the address and name must not survive
 * in delivery history (the suppression list keeps its own minimal record).
 * The rows stay in the `by_contact` range, so the walker pages through them
 * with a saved cursor; inline, they are streamed.
 *
 * A page asks for up to `SCRUB_PAGE` rows and lets Convex stop it at the
 * byte allowance left (`maximumBytesRead`), so small sends go 128 at a time
 * while a page of heavy ones stays inside the allowance plus one document.
 * Convex documents a page stopped that way (`SplitRequired`) as possibly
 * incomplete, so the walk never advances past one: it scrubs the rows it got
 * (scrubbing is idempotent) and reads the page again from the same cursor in
 * the next transaction, sized for maximum-size rows. No send is ever skipped.
 */
function scrubSends<T extends SendTable>(table: T, scrub: () => Partial<Doc<T>>): PhaseRunner {
	const sendTable: SendTable = table;
	return async ({ ctx, contactId, budget, cursor, mode, mayPaginate }): Promise<PhaseOutcome> => {
		// A fresh query per read: a Convex query object runs once.
		const query = () =>
			ctx.db.query(sendTable).withIndex('by_contact', (q) => q.eq('contactId', contactId));
		const scrubOne = async (send: Doc<SendTable>): Promise<void> => {
			budget.charge(send);
			if (!isErasedSend(send)) await ctx.db.patch(send._id, scrub() as never);
		};
		if (mode === 'inline') {
			for await (const send of query()) await scrubOne(send);
			return DONE;
		}

		const readPage = async (from: string | null, isNarrow: boolean): Promise<PhaseOutcome> => {
			const bytesLeft = budget.bytesLeft;
			const page = await query().paginate(
				isNarrow || !Number.isFinite(bytesLeft)
					? { cursor: from, numItems: budget.chunk(SCRUB_PAGE) }
					: {
							cursor: from,
							numItems: budget.pageRows(SCRUB_PAGE),
							maximumBytesRead: bytesLeft,
						}
			);
			if (page.pageStatus === 'SplitRequired') {
				// A page sized for maximum-size rows with no byte cap should never be
				// cut short. Saving the same marker again would loop without a trace;
				// failing the transaction puts it on the job's `lastError`.
				if (isNarrow) {
					throw new Error(
						`Contact erasure: a ${sendTable} page without a byte cap came back SplitRequired`
					);
				}
				for (const send of page.page) await scrubOne(send);
				return { isDone: false, isPaginated: true, cursor: NARROW_PAGE + (from ?? '') };
			}
			for (const send of page.page) await scrubOne(send);
			return page.isDone
				? { isDone: true, isPaginated: true }
				: { isDone: false, isPaginated: true, cursor: page.continueCursor };
		};

		if (cursor !== undefined) {
			// A saved cursor only ever starts a transaction, when no page has run.
			if (!mayPaginate) return { isDone: false, cursor };
			const isNarrow = cursor.startsWith(NARROW_PAGE);
			const from = isNarrow ? cursor.slice(NARROW_PAGE.length) || null : cursor;
			return readPage(from, isNarrow);
		}
		// A short history fits in one read: scrub it without spending this
		// transaction's one paginated query, so a later phase can still page.
		// A longer one pages from the start right away; that page reads the
		// probe's few rows again, and they are charged again.
		const probeSize = budget.chunk(SCRUB_PAGE + 1);
		const head = await query().take(probeSize);
		for (const send of head) await scrubOne(send);
		if (head.length < probeSize) return DONE;
		// Another phase already paged in this transaction: start over next time.
		if (!mayPaginate) return NOT_DONE;
		return readPage(null, false);
	};
}

/**
 * Recorded send completions and their payloads (#1195): each record goes after
 * its payload. The walker drains them through its budget like any other child.
 * The inline driver has no budget, so it deletes one bounded batch and leaves
 * the rest to a scheduled continuation that finds them by `contactId`; no new
 * record can appear, because the contact's Sends are soft-deleted by now.
 */
const eraseSendCompletionFailures: PhaseRunner = async (phase) => {
	const { ctx, contactId, budget, mode } = phase;
	if (mode === 'inline') {
		const rows = await ctx.db
			.query('sendCompletionFailures')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(CONTACT_CLEANUP_BATCH_SIZE);
		for (const row of rows) {
			await deleteCompletionFailurePayload(ctx, row._id);
			await ctx.db.delete(row._id);
		}
		if (rows.length === CONTACT_CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(
				0,
				internal.delivery.sendCompletionFailureAdmin.deleteContactCompletionFailures,
				{ contactId }
			);
		}
		return DONE;
	}
	return await drainParents(
		budget,
		() =>
			ctx.db
				.query('sendCompletionFailures')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.first(),
		async (record) => {
			const isEmpty = await deleteAll(phase, (n) =>
				ctx.db
					.query('sendCompletionFailurePayloads')
					.withIndex('by_failure', (q) => q.eq('failureId', record._id))
					.take(n)
			);
			if (isEmpty) await ctx.db.delete(record._id);
			return isEmpty;
		}
	);
};

const PHASE_RUNNERS: Record<ContactErasurePhase, PhaseRunner> = {
	// Learned clarification answers: deleted, never unlinked — an absent
	// contactId is the org-wide scope. Promoted answers have none already.
	clarificationMemory: deleteByIndex(({ ctx, contactId }, n) =>
		ctx.db
			.query('clarificationMemory')
			.withIndex('by_contact_slot', (q) => q.eq('contactId', contactId))
			.take(n)
	),
	contactTopics: deleteByIndex(({ ctx, contactId }, n) =>
		ctx.db
			.query('contactTopics')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(n)
	),
	contactPropertyValues: deleteByIndex(({ ctx, contactId }, n) =>
		ctx.db
			.query('contactPropertyValues')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(n)
	),
	contactActivities: deleteByIndex(({ ctx, contactId }, n) =>
		ctx.db
			.query('contactActivities')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(n)
	),
	contactIdentities: deleteByIndex(({ ctx, contactId }, n) =>
		ctx.db
			.query('contactIdentities')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(n)
	),
	relationshipsFrom: deleteByIndex(({ ctx, contactId }, n) =>
		ctx.db
			.query('contactRelationships')
			.withIndex('by_from', (q) => q.eq('fromContactId', contactId))
			.take(n)
	),
	relationshipsTo: deleteByIndex(({ ctx, contactId }, n) =>
		ctx.db
			.query('contactRelationships')
			.withIndex('by_to', (q) => q.eq('toContactId', contactId))
			.take(n)
	),
	automationRuns: eraseAutomationRuns,
	emailSends: scrubSends('emailSends', () => ({
		deletedAt: Date.now(),
		deletedBy: 'system',
		contactEmail: ERASED_ADDRESS,
		contactFirstName: undefined,
		contactLastName: undefined,
	})),
	transactionalSends: scrubSends('transactionalSends', () => ({
		deletedAt: Date.now(),
		deletedBy: 'system',
		email: ERASED_ADDRESS,
		// Request-supplied template variables can carry PII (name, address,
		// order details). Erasure must drop them too, not just the address.
		dataVariables: undefined,
	})),
	// A recorded completion can hold the recipient, their name and the message
	// (#1195). The sends are soft-deleted by now, and a completion for a
	// soft-deleted Send records nothing, so none comes back behind the walk.
	sendCompletionFailures: eraseSendCompletionFailures,
	conversationThreads: eraseConversationThreads,
	unifiedMessages: eraseUnifiedMessages,
	inboundMessages: eraseInboundMessages,
	formSubmissions: eraseFormSubmissions,
	knowledge: eraseKnowledge,
	semanticFiles: eraseSemanticFiles,
	// Answer mode ask sessions quote the person's mail; the draft stream each
	// one owns goes with it.
	answerAskSessions: async (phase) => ({
		isDone: await drainEach(
			phase.budget,
			(n) =>
				phase.ctx.db
					.query('answerAskSessions')
					.withIndex('by_contact', (q) => q.eq('contactId', phase.contactId))
					.take(n),
			async (session) => {
				// The stream holds the draft text: its read counts against the bytes.
				const stream = session.streamId ? await phase.ctx.db.get(session.streamId) : null;
				if (stream) {
					phase.budget.chargeRead(stream);
					await phase.ctx.db.delete(stream._id);
				}
				await phase.ctx.db.delete(session._id);
			}
		),
	}),
};

export const FIRST_ERASURE_PHASE: ContactErasurePhase = CONTACT_ERASURE_PHASES[0];

export interface ErasurePosition {
	phase: ContactErasurePhase;
	cursor?: string;
}

export type ErasureProgress = ErasurePosition & { isComplete: boolean };

/**
 * Whether a Send was written for the contact after its scrub phase passed (an
 * agent reply, a transactional send). Rows written behind the walk are the
 * newest in the contact's index range, so the newest row decides.
 */
async function hasLateSend(
	{ ctx, contactId, budget }: Pick<PhaseContext, 'ctx' | 'contactId' | 'budget'>,
	table: SendTable
): Promise<boolean> {
	const newest = await ctx.db
		.query(table)
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.order('desc')
		.first();
	if (!newest) return false;
	budget.chargeRead(newest);
	return !isErasedSend(newest);
}

/**
 * Run phases from `from` onward until the budget runs out or every phase is
 * done. Convex allows one paginated query per transaction; a send phase that
 * finds it spent stops the transaction there.
 *
 * Reaching the end in walker mode re-checks what the walk may have missed: it
 * spans many transactions, and something may have written a new child of the
 * tombstoned contact behind it. The phases that delete rows run again (one
 * empty index probe each when nothing did), and a Send written after its scrub
 * phase sends the walk back to that phase, which skips the rows it already
 * scrubbed; the contact row is only removed once none is left. Inline mode
 * runs in one transaction and needs no re-check.
 */
export async function advanceErasure(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
	from: ErasurePosition,
	budget: ErasureBudget,
	mode: ErasureMode
): Promise<ErasureProgress> {
	let index = CONTACT_ERASURE_PHASES.indexOf(from.phase);
	let cursor = from.cursor;
	let hasPaginated = false;
	while (index < CONTACT_ERASURE_PHASES.length) {
		const phase = CONTACT_ERASURE_PHASES[index]!;
		if (budget.isExhausted) return { phase, cursor, isComplete: false };
		const outcome = await PHASE_RUNNERS[phase]({
			ctx,
			contactId,
			budget,
			cursor,
			mode,
			mayPaginate: !hasPaginated,
		});
		if (outcome.isPaginated) hasPaginated = true;
		if (!outcome.isDone) return { phase, cursor: outcome.cursor, isComplete: false };
		index += 1;
		cursor = undefined;
	}

	if (mode === 'walker') {
		for (const phase of CONTACT_ERASURE_PHASES) {
			if (phase === 'emailSends' || phase === 'transactionalSends') {
				if (budget.isExhausted) return { phase, isComplete: false };
				if (await hasLateSend({ ctx, contactId, budget }, phase)) {
					return { phase, isComplete: false };
				}
				continue;
			}
			if (budget.isExhausted) return { phase, isComplete: false };
			const outcome = await PHASE_RUNNERS[phase]({
				ctx,
				contactId,
				budget,
				cursor: undefined,
				mode,
				// The send phases are checked by `hasLateSend`; none of these pages.
				mayPaginate: false,
			});
			if (!outcome.isDone) return { phase, isComplete: false };
		}
	}
	return { phase: CONTACT_ERASURE_PHASES[CONTACT_ERASURE_PHASES.length - 1]!, isComplete: true };
}

/**
 * The last step once every phase is done: the erasure job rows and the
 * contact row itself, and the cached contact count when the caller has not
 * already decremented it at soft-delete time.
 */
export async function finishErasure(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
	options: { decrementCount: boolean }
): Promise<void> {
	const jobs = await ctx.db
		.query('contactErasureJobs')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.take(8); // at most one job per contact; a few in case of a double start
	for (const job of jobs) await ctx.db.delete(job._id);

	const contact = await ctx.db.get(contactId);
	if (contact) {
		await ctx.db.delete(contactId);
		await recordContactGrowth(ctx, contact, null);
	}
	if (contact && options.decrementCount) await decrementContactCount(ctx, 1);
}
