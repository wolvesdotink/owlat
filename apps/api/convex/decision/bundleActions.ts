'use node';

/**
 * The scheduled Phase 2 bundle actions, one per hook in
 * `./schedule.ts`. Each re-reads the routing policy (a switch may have moved
 * since the hook scheduled it), builds the message's evidence, and hands one
 * bundle to `./bundleRunner.ts`. None returns anything a pipeline reads, and
 * none writes outside `decisionArtifacts` and `senderMemory`.
 *
 * Every action anchors its model budget at entry.
 */

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { anchorActionDeadline } from '../lib/llm/actionDeadline';
import { scopeForInterpretation } from '../mail/interpret/scopeLoad';
import { scopedEvidence } from './scopedEvidence';
import type { InterpretationSource } from '../lib/validators/threadBrief';
import { guardStanding } from '../agent/steps/security_scan/disposition';
import { headerEvidenceFromStoredJson, isBulkPrecedenceForCategory } from '../lib/mailEvidence';
import { teamRoot } from '../agent/shared/agentSpend';
import { extractEmail } from '../lib/emailAddress';
import { postboxRoot } from '../lib/llm/requestMeter';
import {
	POSTBOX_MESSAGE_BUNDLE,
	TEAM_MESSAGE_BUNDLE,
	TRIAGE_BUNDLE,
} from '../lib/decision/bundles';
import {
	buildDecisionState,
	type DecisionEvidence,
	type EvidenceSegment,
} from '../lib/decision/evidence';
import { planMessageBundle, planTriage } from '../lib/decision/routing';
import { runBundle } from './bundleRunner';

const labelsValidator = v.record(v.string(), v.string());

/**
 * A message's body as evidence segments, through interpretation's own scoping
 * and segmentation (`mail/interpret/scope.ts`): an encrypted body is never
 * sent anywhere (null), a clearsigned message is read only inside its signed
 * block, and hidden HTML is stripped.
 */
async function scopedSegments(
	ctx: ActionCtx,
	source: InterpretationSource
): Promise<{ segments: EvidenceSegment[]; isScopeComplete: boolean } | null> {
	const scoped = await scopeForInterpretation(ctx, source);
	return scoped?.ok ? scopedEvidence(scoped) : null;
}

/**
 * A Team message as evidence, or null when it must not be judged: gone,
 * undecryptable, or no longer cleared by the guard (unguarded or
 * rejected content never goes to a model).
 */
async function teamEvidence(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>
): Promise<DecisionEvidence | null> {
	const message: Doc<'inboundMessages'> | null = await ctx.runQuery(
		internal.agent.agentPipeline.getMessage,
		{ inboundMessageId }
	);
	if (!message || guardStanding(message) !== 'clear') return null;
	const body = await scopedSegments(ctx, { kind: 'inbound', id: inboundMessageId });
	if (!body) return null;
	const headers = headerEvidenceFromStoredJson(message.headers);
	return {
		surface: 'team',
		from: extractEmail(message.from),
		to: [extractEmail(message.to)],
		cc: [],
		ownAddresses: [extractEmail(message.to)],
		subject: message.subject,
		...body,
		bulkHeaders: headers.hasListUnsubscribe || isBulkPrecedenceForCategory(headers),
	};
}

/** The message-only triage shadow, scheduled after the security scan. */
export const teamTriage = internalAction({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args): Promise<null> => {
		anchorActionDeadline(ctx);
		const routing = await ctx.runQuery(internal.decision.context.routingContext, {});
		const plan = planTriage(routing.policy);
		if (!plan) return null;
		const evidence = await teamEvidence(ctx, args.inboundMessageId);
		if (!evidence) return null;
		await runBundle(ctx, {
			bundle: TRIAGE_BUNDLE,
			plan,
			routing,
			subject: { kind: 'inbound_message', inboundMessageId: args.inboundMessageId },
			built: buildDecisionState(evidence),
			root: teamRoot(args.inboundMessageId),
		});
		return null;
	},
});

/** The Team category and disposition bundle, beside the classifier it is compared with. */
export const teamMessage = internalAction({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		baseline: labelsValidator,
		language: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<null> => {
		anchorActionDeadline(ctx);
		const routing = await ctx.runQuery(internal.decision.context.routingContext, {});
		const plan = planMessageBundle(routing.policy);
		if (!plan) return null;
		const evidence = await teamEvidence(ctx, args.inboundMessageId);
		if (!evidence) return null;
		await runBundle(ctx, {
			bundle: TEAM_MESSAGE_BUNDLE,
			plan,
			routing,
			subject: { kind: 'inbound_message', inboundMessageId: args.inboundMessageId },
			built: buildDecisionState(evidence),
			root: teamRoot(args.inboundMessageId),
			baseline: args.baseline,
			...(args.language ? { language: args.language } : {}),
		});
		return null;
	},
});

/** The Postbox category and disposition bundle, for mail the heuristic left ambiguous. */
export const postboxMessage = internalAction({
	args: {
		threadId: v.id('mailThreads'),
		expectedLatestMessageId: v.optional(v.id('mailMessages')),
		baseline: labelsValidator,
	},
	handler: async (ctx, args): Promise<null> => {
		anchorActionDeadline(ctx);
		const routing = await ctx.runQuery(internal.decision.context.routingContext, {});
		const plan = planMessageBundle(routing.policy);
		if (!plan) return null;
		const subject = await ctx.runQuery(internal.decision.postboxEvidence.postboxSubject, {
			threadId: args.threadId,
			...(args.expectedLatestMessageId
				? { expectedLatestMessageId: args.expectedLatestMessageId }
				: {}),
		});
		if (!subject) return null;
		const body = await scopedSegments(ctx, { kind: 'mail', id: subject.mailMessageId });
		if (!body) return null;
		await runBundle(ctx, {
			bundle: POSTBOX_MESSAGE_BUNDLE,
			plan,
			routing,
			subject: {
				kind: 'mail_message',
				mailMessageId: subject.mailMessageId,
				mailboxId: subject.mailboxId,
			},
			built: buildDecisionState({ ...subject.evidence, ...body }),
			root: postboxRoot(args.threadId, subject.mailMessageId),
			baseline: args.baseline,
		});
		return null;
	},
});
