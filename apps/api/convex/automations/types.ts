import type { ActionCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { CoreStepKind } from './steps/catalog';
import type { MarketingIneligibility } from '../lib/marketingEligibility';

export type { CoreStepKind, StepKind } from './steps/catalog';

export type StepOutcome =
	| { status: 'completed'; emailSendId?: string; nextStepIndex?: number }
	| { status: 'failed'; error: string }
	// The contact stopped being eligible for marketing between the claim and the
	// send (see lib/marketingEligibility.ts). Ends the run; never retried.
	| { status: 'contact_ineligible'; reason: MarketingIneligibility };

export interface StepExecuteArgs<C> {
	config: C;
	contact: Doc<'contacts'>;
	automation: Doc<'automations'>;
	stepRunId: Id<'automationStepRuns'>;
}

export interface StepModule<T extends CoreStepKind, C> {
	readonly kind: T;
	parseConfig(raw: unknown): C;
	entryDelay?(config: C): number;
	execute(ctx: ActionCtx, args: StepExecuteArgs<C>): Promise<StepOutcome>;
	/**
	 * Optional query-time enrichment — fields merged into the step row by
	 * `getWithRelations` so the FE can render derived joins (e.g. the email
	 * template a step references). Only kinds that own a join implement
	 * this; the dispatcher returns `{}` for the rest.
	 */
	enrichForQuery?(ctx: Pick<QueryCtx, 'db'>, config: C): Promise<Record<string, unknown>>;
}
