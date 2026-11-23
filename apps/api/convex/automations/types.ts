import type { ActionCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { CoreStepKind } from './steps/catalog';
import type { MarketingIneligibility } from '../lib/marketingEligibility';
import type { AutomationStepFailureReason } from '../lib/validators/automations';

export type { CoreStepKind, StepKind } from './steps/catalog';

export type StepOutcome =
	| { status: 'completed'; emailSendId?: string; nextStepIndex?: number }
	// `reason` is the coded cause the runs panel shows; `error` the English detail.
	| { status: 'failed'; reason: AutomationStepFailureReason; error: string }
	// The contact stopped being eligible for marketing between the claim and the
	// send (see lib/marketingEligibility.ts). The step is skipped and never
	// retried; a deleted contact's run is cancelled, an unsubscribed one's moves on.
	| { status: 'contact_ineligible'; reason: MarketingIneligibility }
	// The run, the automation or the step went away between the claim and the
	// send. The intake already ended the step run, so the walker commits nothing.
	| { status: 'ended'; reason: string };

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
