/**
 * D1 for background work (ADR-0073, Phase 1b): at the spend ceiling, or with
 * a spend state that cannot be verified, background AI work defers instead of
 * spending. A deferred semantic file keeps its extracted text now and is
 * processed again later, up to {@link MAX_FILE_DEFERRALS} times (a day), so
 * the summary and embedding arrive once the ceiling resets.
 *
 * Two ways a file defers: the headroom check before its paid stages
 * ({@link deferFileForBudget}), and a refusal of one paid call at its
 * dispatch ({@link owedFileStages}: the summary, or the embedding, which the
 * embedding plane's own cap can refuse alone). The stages still owed travel in
 * the scheduled run's arguments, so a summary that already landed is reused
 * ({@link reusableSummary}) rather than bought twice. Runtime-neutral.
 */

import { v, type Infer } from 'convex/values';
import type { FunctionReference } from 'convex/server';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { AdmissionRefusedError, admissionRefusalOf } from '../lib/llm/admissionPort';

/** How long a deferred file waits before it is processed again. */
export const FILE_DEFER_MS = 60 * 60 * 1000;

/** How many times a file defers before it is left to the backfill paths. */
export const MAX_FILE_DEFERRALS = 24;

/** Whether background work has headroom now (nothing is held). */
export async function backgroundHasHeadroom(ctx: Pick<ActionCtx, 'runQuery'>): Promise<boolean> {
	const verdict = await ctx.runQuery(internal.aiRouting.admission.headroom, {
		plane: 'language',
		budgetClass: 'standard',
		priority: 'background',
	});
	return verdict.isAdmitted;
}

/**
 * True when the file's paid steps must defer: then a later run is scheduled
 * (while deferrals remain) and the caller skips its model and embedding calls.
 */
export async function deferFileForBudget(
	ctx: Pick<ActionCtx, 'runQuery' | 'scheduler'>,
	fileId: Id<'semanticFiles'>,
	deferrals: number | undefined,
	/** The stages this run owes; the later run owes the same. */
	stages?: readonly FileStage[]
): Promise<boolean> {
	if (await backgroundHasHeadroom(ctx)) return false;
	const done = deferrals ?? 0;
	if (done < MAX_FILE_DEFERRALS) {
		await ctx.scheduler.runAfter(FILE_DEFER_MS, internal.semanticFileProcessing.processFile, {
			fileId,
			deferrals: done + 1,
			...(stages ? { stages: [...stages] } : {}),
		});
	}
	return true;
}

/** The paid stages of processing one file. */
export const FILE_STAGES = ['summary', 'embedding'] as const;
export type FileStage = (typeof FILE_STAGES)[number];
export const fileStageValidator = v.union(v.literal('summary'), v.literal('embedding'));

/** The stages a run's refused calls leave owed, and the later run that settles them. */
export interface OwedFileStages {
	/** Record a failed stage. True when spend admission refused it (the stages are owed). */
	note(error: unknown, stages: readonly FileStage[]): boolean;
	/** Schedule the run that owes them, while deferrals remain. */
	schedule(): Promise<void>;
}

export function owedFileStages(
	ctx: Pick<ActionCtx, 'scheduler'>,
	fileId: Id<'semanticFiles'>,
	deferrals: number | undefined
): OwedFileStages {
	const owed = new Set<FileStage>();
	return {
		note(error, stages) {
			if (!admissionRefusalOf(error)) return false;
			for (const stage of stages) owed.add(stage);
			return true;
		},
		async schedule() {
			const done = deferrals ?? 0;
			if (owed.size === 0 || done >= MAX_FILE_DEFERRALS) return;
			await ctx.scheduler.runAfter(FILE_DEFER_MS, internal.semanticFileProcessing.processFile, {
				fileId,
				deferrals: done + 1,
				stages: FILE_STAGES.filter((stage) => owed.has(stage)),
			});
		},
	};
}

/**
 * The summary an earlier run stored, when this run owes only the embedding:
 * reused instead of calling the model again. Undefined when it is owed too.
 */
export function reusableSummary(
	file: Pick<Doc<'semanticFiles'>, 'title' | 'summary' | 'autoTags'>,
	stages: readonly Infer<typeof fileStageValidator>[] | undefined
): { title: string | undefined; summary: string; autoTags: string[] } | undefined {
	if (stages === undefined || stages.includes('summary') || file.summary === undefined) {
		return undefined;
	}
	return { title: file.title, summary: file.summary, autoTags: file.autoTags ?? [] };
}

/** How long a deferred background run waits before it runs again. */
export const BACKGROUND_DEFER_MS = 60 * 60 * 1000;

/** How many times a background run defers before it gives up (a day). */
export const MAX_BACKGROUND_DEFERRALS = 24;

export { rethrowAdmissionRefusal } from '../lib/llm/admissionPort';

/**
 * A background action that can be scheduled again with its own arguments plus
 * `deferrals`. Typed loosely on purpose: the action names itself, and a
 * precise type would make its type depend on itself.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
export type DeferrableAction = FunctionReference<'action', 'internal', any>;

/** The arguments a deferrable background run takes. */
interface DeferrableArgs {
	readonly deferrals?: number;
	readonly root?: {
		readonly rootRequestId: string;
		readonly parentCallId?: string;
		readonly deadlineAt?: number;
	};
}

/**
 * Run background AI work; when spend admission refuses it (the gate or a call
 * at its dispatch, let through the work's own fail-soft catches with
 * {@link rethrowAdmissionRefusal}), schedule the same run an hour later, at
 * most {@link MAX_BACKGROUND_DEFERRALS} times, and return undefined. A root
 * deadline is dropped: the later run anchors its own. Any other error is the
 * work's own.
 */
export async function deferRefusedRun<Args extends DeferrableArgs, Result>(
	ctx: Pick<ActionCtx, 'scheduler'>,
	fn: DeferrableAction,
	args: Args,
	run: () => Promise<Result>
): Promise<Result | undefined> {
	try {
		return await run();
	} catch (error) {
		if (!admissionRefusalOf(error)) throw error;
		const done = args.deferrals ?? 0;
		if (done < MAX_BACKGROUND_DEFERRALS) {
			const root = args.root
				? {
						root: {
							rootRequestId: args.root.rootRequestId,
							...(args.root.parentCallId ? { parentCallId: args.root.parentCallId } : {}),
						},
					}
				: {};
			await ctx.scheduler.runAfter(BACKGROUND_DEFER_MS, fn, {
				...args,
				...root,
				deferrals: done + 1,
			} as never);
		}
		return undefined;
	}
}

/**
 * Thrown by background work whose own fail-soft step already recorded a budget
 * refusal (an interpretation that came back `budget`), so the run defers like
 * a refused call.
 */
export class BudgetDeferral extends AdmissionRefusedError {
	constructor() {
		super('spend_unverifiable', 'deferred');
		this.name = 'BudgetDeferral';
	}
}

/**
 * A background action's handler that defers when spend admission refuses it
 * ({@link deferRefusedRun}). `fn` names the action itself, as a thunk so the
 * module's own reference is read when the handler runs.
 */
export function deferredHandler<Args extends DeferrableArgs>(
	fn: () => DeferrableAction,
	handler: (ctx: ActionCtx, args: Args) => Promise<void>
): (ctx: ActionCtx, args: Args) => Promise<void> {
	return async (ctx, args) => {
		await deferRefusedRun(ctx, fn(), args, () => handler(ctx, args));
	};
}
