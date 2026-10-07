/**
 * `applyInterpretation` (SPEC §4 `reduce.ts`): fold one message's grounded,
 * verified interpretation into its thread, in ONE transaction:
 *
 *   1. recheck that the source still exists in this thread and that no purge
 *      ran since the run loaded (`deletionEpoch`); otherwise drop the write;
 *   2. compare-and-set on `threadBriefs.interpretationRevision`: a run that
 *      loaded an older revision gets `stale` back and retries against the new
 *      state (the extraction is reused, the model is not called again);
 *   3. store the extraction (`messageInterpretations`, sealed payload; one row
 *      per source + content revision + extractor version, replays are no-ops);
 *   4. apply the plan of `reducePlan.ts`: new items (ids allocated here),
 *      evidence merges, status and disposition edges, fact upserts;
 *   5. append `threadActivity` for every change, through `appendActivity`;
 *   6. bump the brief row: revision, checkpoint, completeness.
 *
 * Every derived string (assertion, display, quotes, fact text) is sealed with
 * the body seal before it is written.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import type { BriefCompleteness } from '@owlat/shared/threadBrief';
import {
	interpretationSourceKey,
	type Evidence,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import {
	rowMatchesThreadRef,
	threadRefToFields,
	type ThreadRef,
} from '../../lib/validators/threadRef';
import { openMessageBody, sealBodyAtWrite } from '../../lib/messageBody';
import { INTERPRET_PAYLOAD_VERSION } from './schema';
import { ensureBriefRow } from './briefRow';
import { appendActivity } from './activity';
import { loadPromptItemCandidates, threadItemsWithStatus } from './load';
import {
	applyInterpretationArgs,
	type ReduceEvidence,
	type ReduceFact,
	type ReduceItem,
} from './reduceInput';
import {
	counterpartyKeyOf,
	planReduction,
	responsibilityOf,
	type PlanFact,
	type PlanItem,
} from './reducePlan';

/** Interpretations scanned per thread when completeness is recomputed. */
const COMPLETENESS_SCAN = 200;
/** Current facts read into the plan. */
const FACT_SCAN = 200;

export type ApplyOutcome =
	| {
			outcome: 'applied' | 'replayed';
			interpretationId: Id<'messageInterpretations'>;
			interpretationRevision: number;
			createdItemIds: Id<'threadItems'>[];
			completeness: BriefCompleteness;
	  }
	| { outcome: 'stale'; interpretationRevision: number }
	| { outcome: 'erased' | 'gone' };

/** Does the source still exist, in this thread? */
async function sourceStillInThread(
	ctx: MutationCtx,
	source: InterpretationSource,
	ref: ThreadRef
): Promise<boolean> {
	switch (source.kind) {
		case 'mail':
		case 'outboundMail': {
			const message = await ctx.db.get(source.id);
			return !!message && ref.kind === 'mail' && message.threadId === ref.id;
		}
		case 'inbound': {
			const inbound = await ctx.db.get(source.id);
			return !!inbound && ref.kind === 'team' && inbound.threadId === ref.id;
		}
		case 'teamReply': {
			const reply = await ctx.db.get(source.id);
			const inbound = reply?.inboundMessageId ? await ctx.db.get(reply.inboundMessageId) : null;
			return !!inbound && ref.kind === 'team' && inbound.threadId === ref.id;
		}
	}
}

/** Seal one quote list into stored evidence. */
async function sealEvidence(
	evidence: readonly ReduceEvidence[],
	source: InterpretationSource,
	contentRevision: string
): Promise<Evidence[]> {
	return Promise.all(
		evidence.map(async (e) => ({
			source,
			segmentId: e.segmentId,
			start: e.start,
			end: e.end,
			contentRevision,
			quote: await sealBodyAtWrite(e.quote),
		}))
	);
}

async function sealDisplay(display: { en: string; de: string }) {
	return { en: await sealBodyAtWrite(display.en), de: await sealBodyAtWrite(display.de) };
}

async function sealFactValue(value: ReduceFact['value']): Promise<Doc<'threadFacts'>['value']> {
	if (!value) return undefined;
	if (value.kind === 'date' || value.kind === 'money') return value;
	return { kind: value.kind, text: await sealBodyAtWrite(value.text) };
}

/**
 * Completeness of the thread from its extractions: partial while the newest
 * extraction of any source failed, came back partial, or could not be read.
 */
export function completenessOf(
	rows: ReadonlyArray<
		Pick<Doc<'messageInterpretations'>, 'sourceKey' | 'status' | 'skipReason' | 'updatedAt'>
	>
): BriefCompleteness {
	const newest = new Map<string, (typeof rows)[number]>();
	for (const row of rows) {
		const seen = newest.get(row.sourceKey);
		if (!seen || row.updatedAt > seen.updatedAt) newest.set(row.sourceKey, row);
	}
	if (newest.size === 0) return 'none';
	for (const row of newest.values()) {
		if (row.status === 'failed' || row.status === 'partial') return 'partial';
		if (row.status === 'skipped' && row.skipReason === 'undecryptable') return 'partial';
	}
	return 'complete';
}

async function threadInterpretations(ctx: MutationCtx, ref: ThreadRef) {
	return ref.kind === 'mail'
		? ctx.db
				.query('messageInterpretations')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', ref.id))
				.order('desc')
				.take(COMPLETENESS_SCAN)
		: ctx.db
				.query('messageInterpretations')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', ref.id))
				.order('desc')
				.take(COMPLETENESS_SCAN);
}

async function loadPlanState(ctx: MutationCtx, ref: ThreadRef, mode: 'brief' | 'actions') {
	const { rows } = await loadPromptItemCandidates(ctx, ref);
	// Every open item takes part in matching, not only the prompt page.
	const open = await threadItemsWithStatus(ctx, ref, 'open', 500);
	const byId = new Map<string, Doc<'threadItems'>>();
	for (const row of [...rows, ...open]) byId.set(row._id, row);
	const items: PlanItem[] = await Promise.all(
		[...byId.values()].map(async (row) => ({
			...row,
			assertionText: await openMessageBody(row.assertion),
		}))
	);
	let facts: PlanFact[] = [];
	if (mode === 'brief' && ref.kind === 'mail') {
		const rowsF = await ctx.db
			.query('threadFacts')
			.withIndex('by_mail_thread_and_status', (q) =>
				q.eq('mailThreadId', ref.id).eq('status', 'current')
			)
			.take(FACT_SCAN);
		facts = await Promise.all(
			rowsF.map(async (row) => ({
				...row,
				...(row.value && 'text' in row.value
					? { valueText: await openMessageBody(row.value.text) }
					: {}),
			}))
		);
	}
	return { items, facts };
}

export const applyInterpretation = internalMutation({
	args: applyInterpretationArgs,
	handler: async (ctx, args): Promise<ApplyOutcome> => {
		const ref = args.threadRef;
		if (!(await sourceStillInThread(ctx, args.source, ref))) return { outcome: 'gone' };
		const brief = await ensureBriefRow(ctx, ref, args.mode);
		if (!brief) return { outcome: 'gone' };
		if (brief.deletionEpoch !== args.deletionEpoch) return { outcome: 'erased' };

		const sourceKey = interpretationSourceKey(args.source);
		const existing = await ctx.db
			.query('messageInterpretations')
			.withIndex('by_source_revision', (q) =>
				q
					.eq('sourceKey', sourceKey)
					.eq('contentRevision', args.contentRevision)
					.eq('extractorVersion', args.extractorVersion)
			)
			.first();
		if (existing?.appliedAt !== undefined && !rowMatchesThreadRef(existing, ref)) {
			return { outcome: 'gone' };
		}
		if (existing?.appliedAt !== undefined && existing.status === args.status) {
			return {
				outcome: 'replayed',
				interpretationId: existing._id,
				interpretationRevision: brief.interpretationRevision,
				createdItemIds: [],
				completeness: brief.completeness,
			};
		}
		if (brief.interpretationRevision !== args.expectedRevision) {
			return { outcome: 'stale', interpretationRevision: brief.interpretationRevision };
		}

		const now = Date.now();
		const isOutOfOrder = !!brief.checkpoint && args.sourceAt < brief.checkpoint.sourceAt;
		const record = {
			...threadRefToFields(ref),
			source: args.source,
			sourceKey,
			contentRevision: args.contentRevision,
			extractorVersion: args.extractorVersion,
			mode: args.mode,
			status: args.status,
			...(args.skipReason ? { skipReason: args.skipReason } : {}),
			...(args.eligibility ? { eligibility: args.eligibility } : {}),
			...(args.sourceManifest ? { sourceManifest: args.sourceManifest } : {}),
			...(args.coverage ? { coverage: args.coverage } : {}),
			...(args.errorCode ? { errorCode: args.errorCode } : {}),
			...(args.result
				? {
						payload: await sealBodyAtWrite(JSON.stringify(args.result)),
						payloadVersion: INTERPRET_PAYLOAD_VERSION,
					}
				: {}),
			deletionEpoch: brief.deletionEpoch,
			appliedAt: now,
			updatedAt: now,
		};
		let interpretationId: Id<'messageInterpretations'>;
		if (existing) {
			await ctx.db.replace(existing._id, { ...record, createdAt: existing.createdAt });
			interpretationId = existing._id;
		} else {
			interpretationId = await ctx.db.insert('messageInterpretations', {
				...record,
				createdAt: now,
			});
		}

		const createdItemIds: Id<'threadItems'>[] = [];
		const actor = { kind: 'system' as const };
		const activityBase = { threadRef: ref, mode: args.mode, eventAt: args.sourceAt };
		const keyBase = `interp:${sourceKey}:${args.contentRevision}:${args.extractorVersion}`;

		if (args.direction === 'inbound') {
			await appendActivity(ctx, {
				...activityBase,
				idempotencyKey: `received:${sourceKey}`,
				type: 'message_received',
				actor: { kind: 'sender' },
				provenance: 'recorded',
				payload: { source: sourceKey },
			});
		}

		if (args.result) {
			const state = await loadPlanState(ctx, ref, args.mode);
			const plan = planReduction(state, args.result, args.contentRevision, {
				mode: args.mode,
				threadKind: ref.kind,
				isOutOfOrder,
			});

			const mailboxId = ref.kind === 'mail' ? (await ctx.db.get(ref.id))?.mailboxId : undefined;
			for (const [index, insert] of plan.inserts.entries()) {
				const id = await insertItem(ctx, {
					ref,
					item: insert.item,
					possibleDuplicateOfId: insert.possibleDuplicateOfId,
					source: args.source,
					contentRevision: args.contentRevision,
					sourceAt: args.sourceAt,
					mailboxId,
					assigneeUserId: ref.kind === 'team' ? args.threadAssigneeUserId : undefined,
					now,
				});
				createdItemIds.push(id);
				await appendActivity(ctx, {
					...activityBase,
					idempotencyKey: `${keyBase}:item:${index}`,
					type: 'item_opened',
					actor,
					provenance: 'reported',
					itemId: id,
					itemRevision: 1,
				});
			}

			const itemsById = new Map(state.items.map((item) => [item._id as string, item]));
			for (const p of plan.patches) {
				const item = itemsById.get(p.itemId);
				if (!item) continue;
				const hasChange =
					p.status !== undefined ||
					p.disposition !== undefined ||
					(p.addEvidence?.length ?? 0) > 0 ||
					p.fill !== undefined ||
					p.verify !== undefined ||
					(p.isReviewNeeded === true && item.isReviewNeeded !== true);
				if (!hasChange) continue;
				const revision = item.revision + 1;
				await ctx.db.patch(p.itemId, {
					revision,
					...(p.status !== undefined ? { status: p.status, completion: p.completion } : {}),
					...(p.disposition !== undefined ? { disposition: p.disposition } : {}),
					...(p.addEvidence?.length
						? {
								evidence: [
									...item.evidence,
									...(await sealEvidence(p.addEvidence, args.source, args.contentRevision)),
								],
							}
						: {}),
					...p.fill,
					...(p.verify ? { verify: p.verify } : {}),
					...(p.isReviewNeeded ? { isReviewNeeded: true } : {}),
					updatedAt: now,
				});
				if (p.activity) {
					await appendActivity(ctx, {
						...activityBase,
						idempotencyKey: `${keyBase}:patch:${p.itemId}`,
						type: p.activity.type,
						actor,
						provenance: 'reported',
						itemId: p.itemId,
						itemRevision: revision,
						...(p.activity.delta ? { delta: p.activity.delta } : {}),
					});
				}
			}

			for (const [index, op] of plan.facts.entries()) {
				if (ref.kind !== 'mail') break;
				if (op.kind === 'supersede') {
					const fact = await ctx.db.get(op.factId);
					if (fact) {
						await ctx.db.patch(op.factId, {
							status: 'superseded',
							revision: fact.revision + 1,
							updatedAt: now,
						});
					}
				} else if (op.kind === 'evidence') {
					const fact = await ctx.db.get(op.factId);
					if (fact) {
						await ctx.db.patch(op.factId, {
							evidence: [
								...fact.evidence,
								...(await sealEvidence(op.addEvidence, args.source, args.contentRevision)),
							],
							revision: fact.revision + 1,
							updatedAt: now,
						});
					}
				} else {
					const factId = await ctx.db.insert('threadFacts', {
						...threadRefToFields(ref),
						factKey: op.fact.key,
						assertion: await sealBodyAtWrite(op.fact.assertion),
						display: await sealDisplay(op.fact.display),
						...(op.fact.value ? { value: await sealFactValue(op.fact.value) } : {}),
						evidence: await sealEvidence(op.fact.evidence, args.source, args.contentRevision),
						provenance: 'reported',
						...(op.supersedesId ? { supersedesId: op.supersedesId } : {}),
						...(op.conflictsWithId ? { conflictsWithId: op.conflictsWithId } : {}),
						status: 'current',
						revision: 1,
						createdAt: now,
						updatedAt: now,
					});
					if (op.supersedesId || op.conflictsWithId) {
						await appendActivity(ctx, {
							...activityBase,
							idempotencyKey: `${keyBase}:fact:${index}`,
							type: 'fact_changed',
							actor,
							provenance: 'reported',
							delta: { factId },
						});
					}
				}
			}
		}

		if (args.status === 'partial' || args.status === 'failed') {
			await appendActivity(ctx, {
				...activityBase,
				idempotencyKey: `${keyBase}:incomplete:${args.status}`,
				type: 'interpretation_incomplete',
				actor,
				provenance: 'recorded',
				payload: { status: args.status, ...(args.errorCode ? { code: args.errorCode } : {}) },
			});
		}

		const completeness = completenessOf(await threadInterpretations(ctx, ref));
		const fresh = (await ctx.db.get(brief._id)) ?? brief;
		const revision = brief.interpretationRevision + 1;
		await ctx.db.patch(brief._id, {
			interpretationRevision: revision,
			sourceRevision: fresh.sourceRevision + 1,
			completeness,
			...(!isOutOfOrder
				? { checkpoint: { sourceKey, sourceAt: args.sourceAt, interpretationId } }
				: {}),
			updatedAt: now,
		});
		return {
			outcome: 'applied',
			interpretationId,
			interpretationRevision: revision,
			createdItemIds,
			completeness,
		};
	},
});

async function insertItem(
	ctx: MutationCtx,
	args: {
		ref: ThreadRef;
		item: ReduceItem;
		possibleDuplicateOfId?: Id<'threadItems'>;
		source: InterpretationSource;
		contentRevision: string;
		sourceAt: number;
		mailboxId?: Id<'mailboxes'>;
		assigneeUserId?: string;
		now: number;
	}
): Promise<Id<'threadItems'>> {
	const { item } = args;
	const counterpartyKey = counterpartyKeyOf(item);
	return ctx.db.insert('threadItems', {
		...threadRefToFields(args.ref),
		...(args.mailboxId ? { mailboxId: args.mailboxId } : {}),
		revision: 1,
		intent: item.intent,
		facets: item.facets,
		...(item.consequences ? { consequences: item.consequences } : {}),
		assertion: await sealBodyAtWrite(item.assertion),
		display: await sealDisplay(item.display),
		requester: item.requester,
		responsible: item.responsible,
		...(item.beneficiary ? { beneficiary: item.beneficiary } : {}),
		responsibility: responsibilityOf(item.responsible),
		...(args.assigneeUserId ? { assigneeUserId: args.assigneeUserId } : {}),
		status: 'open',
		disposition: 'unanswered',
		...(item.due ? { due: item.due } : {}),
		...(item.amount ? { amount: item.amount } : {}),
		...(item.options ? { options: item.options } : {}),
		evidence: await sealEvidence(item.evidence, args.source, args.contentRevision),
		...(args.possibleDuplicateOfId ? { possibleDuplicateOfId: args.possibleDuplicateOfId } : {}),
		verify: item.verify,
		...(item.isReviewNeeded ? { isReviewNeeded: true } : {}),
		...(counterpartyKey ? { counterpartyKey } : {}),
		askedAt: args.sourceAt,
		createdAt: args.now,
		updatedAt: args.now,
	});
}
