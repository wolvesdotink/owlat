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
import { deleteAutomationRun } from '../../automations/runDeletion';
import type { ErasureBudget } from './budget';
import { CONTACT_ERASURE_PHASES, type ContactErasurePhase } from './phaseCatalog';
import {
	DONE,
	NOT_DONE,
	deleteAll,
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

/** Sends scrubbed per page of the paginated send phases. */
const SCRUB_PAGE = 128;

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
		const progress = await deleteAutomationRun(ctx, run._id, budget.chunk(256));
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
 */
function scrubSends<T extends SendTable>(table: T, scrub: () => Partial<Doc<T>>): PhaseRunner {
	const sendTable: SendTable = table;
	return async ({ ctx, contactId, budget, cursor, mode }): Promise<PhaseOutcome> => {
		// A fresh query per read: a Convex query object runs once.
		const query = () =>
			ctx.db.query(sendTable).withIndex('by_contact', (q) => q.eq('contactId', contactId));
		if (mode === 'inline') {
			for await (const send of query()) {
				budget.charge(send);
				if (!isErasedSend(send)) await ctx.db.patch(send._id, scrub() as never);
			}
			return DONE;
		}
		// A short history fits in one read: scrub it without spending this
		// transaction's one paginated query, so later phases can still run.
		const pageSize = budget.chunk(SCRUB_PAGE);
		if (cursor === undefined) {
			const head = await query().take(pageSize + 1);
			if (head.length <= pageSize) {
				for (const send of head) {
					budget.charge(send);
					if (!isErasedSend(send)) await ctx.db.patch(send._id, scrub() as never);
				}
				return DONE;
			}
		}
		const page = await query().paginate({
			cursor: cursor ?? null,
			numItems: pageSize,
		});
		for (const send of page.page) {
			budget.charge(send);
			if (!isErasedSend(send)) await ctx.db.patch(send._id, scrub() as never);
		}
		return page.isDone
			? { isDone: true, isPaginated: true }
			: { isDone: false, isPaginated: true, cursor: page.continueCursor };
	};
}

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
	conversationThreads: eraseConversationThreads,
	unifiedMessages: eraseUnifiedMessages,
	inboundMessages: eraseInboundMessages,
	formSubmissions: eraseFormSubmissions,
	knowledge: eraseKnowledge,
	semanticFiles: eraseSemanticFiles,
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
	budget.charge(newest);
	return !isErasedSend(newest);
}

/**
 * Run phases from `from` onward until the budget runs out, a paginated query
 * has used this transaction's one allowance, or every phase is done.
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
	while (index < CONTACT_ERASURE_PHASES.length) {
		const phase = CONTACT_ERASURE_PHASES[index]!;
		if (budget.isExhausted) return { phase, cursor, isComplete: false };
		const outcome = await PHASE_RUNNERS[phase]({ ctx, contactId, budget, cursor, mode });
		if (!outcome.isDone) return { phase, cursor: outcome.cursor, isComplete: false };
		index += 1;
		cursor = undefined;
		const next = CONTACT_ERASURE_PHASES[index];
		if (outcome.isPaginated && next !== undefined) return { phase: next, isComplete: false };
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
	if (contact) await ctx.db.delete(contactId);
	if (contact && options.decrementCount) await decrementContactCount(ctx, 1);
}
