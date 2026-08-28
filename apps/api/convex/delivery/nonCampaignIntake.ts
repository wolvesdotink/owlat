/**
 * Non-campaign send intake (module) — the ONE intake path for every 1:1,
 * non-template-API Send: automation email steps and agent approved-replies.
 *
 * Sibling of the Template API intake (`transactional/dispatch.ts`) and modelled
 * on it deliberately: the same pre-row gate sequence (via the shared
 * **Send intake gates (module)**), the same in-transaction route resolution,
 * the same `transactionalSends` row insert → `sendAssignments` record →
 * transactional-workpool enqueue, and the same `ok`-discriminated outcome.
 * It exists as a separate module rather than a mode of `dispatch` because the
 * two differ on their INPUT (a pre-rendered subject+html for a known
 * recipient, vs a stored template + `dataVariables` + contact upsert), not on
 * what they do with it.
 *
 * WHAT THIS REPLACES. Until PIECE C2 this was `delivery/enqueue.ts:
 * enqueueNonCampaignSend`, which signalled its two refusals by throwing
 * `new Error('recipient_blocked')` / `new Error('no_delivery_provider')` from
 * exported magic-string constants. The automation step re-classified the
 * refusal by string-matching `error.message`; the agent reply path did not
 * match at all and flattened a SUPPRESSED RECIPIENT — an expected, permanent,
 * per-recipient outcome — into the same generic `failed` transition as a real
 * fault. The outcome union below is what both call sites now switch on, and
 * both mappings are total records, so a new rejection reason is a compile
 * error at every consumer rather than a silently mis-handled string.
 *
 * The subject + html are PRE-RENDERED by the caller (automation personalizes
 * against the contact; agent escapes its draft). They are passed straight to
 * the transactional envelope with NO `dataVariables`, so the transactional
 * composer's re-personalization is a no-op on already-substituted text.
 */

import { type Infer, v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { transactionalEmailPool } from './workpool';
import type { SuppressionScope } from '../lib/suppression';
import type { MessageType } from '../lib/sendProviders/route';
import { recordSendAssignments } from './sendAssignments';
import { normalizeEngagementScore } from './workerEnvelope';
import { runSendIntakeGates, type SendIntakeRejectionReason } from './sendIntakeGates';

// ============================================================
// Public types
// ============================================================

/**
 * Why the non-campaign intake refused. Exactly the shared
 * {@link SendIntakeRejectionReason} vocabulary — this intake takes no template
 * and no caller-supplied variables, so it has no reasons of its own to add.
 */
export type NonCampaignIntakeRejectionReason = SendIntakeRejectionReason;

/**
 * The discriminated outcome, modelled on `transactional/dispatch.ts`'s
 * `DispatchOutcome`. `queued: true` is the same literal marker: an `ok`
 * outcome means a `transactionalSends` row exists in `queued` and a worker job
 * is enqueued — NOT that anything was delivered. Every `{ ok: false }` is
 * final for this attempt and left no row behind (see the gates module).
 */
export type NonCampaignIntakeOutcome =
	| {
			ok: true;
			sendId: Id<'transactionalSends'>;
			queued: true;
	  }
	| {
			ok: false;
			reason: NonCampaignIntakeRejectionReason;
			detail?: string;
	  };

/** The kinds of mail this intake writes. */
const nonCampaignSendKindValidator = v.union(v.literal('automation'), v.literal('agent_reply'));

/** @see nonCampaignSendKindValidator */
export type NonCampaignSendKind = Infer<typeof nonCampaignSendKindValidator>;

// ============================================================
// Per-kind policy tables
// ============================================================

/**
 * Which {@link SuppressionScope} each non-campaign kind is gated at.
 *
 * TOTAL BY CONSTRUCTION, and deliberately so. The `satisfies
 * Record<NonCampaignSendKind, SuppressionScope>` makes adding a third literal
 * to {@link nonCampaignSendKindValidator} a COMPILE ERROR until the new kind
 * names its scope — where a ternary with a permissive else-branch would have
 * silently handed it the transactional reading and stopped marketing-hygiene
 * rows blocking it. `lib/suppression.ts` states the same invariant for the
 * default: forgetting to think about scope must yield the blocking behaviour,
 * never the permissive one.
 *
 * THE SCOPE IS PER-KIND because this intake writes two very different kinds of
 * mail. An `automation` step is marketing — it takes the strict scope, so a
 * marketing-hygiene row (`unengaged`) blocks it like every other reason. An
 * `agent_reply` is a 1:1 answer to a human who wrote in; it carries no
 * List-Unsubscribe, is classified as the `transactional` stream for routing,
 * and must not be thrown away because the same person stopped opening
 * campaigns — that inbound is the clearest possible evidence they are still
 * there. Bounce, complaint and manual rows still block it:
 * `isMarketingOnlyBlockReason` is false for those, so the transactional scope
 * keeps blocking on mailbox evidence.
 */
const SUPPRESSION_SCOPE_BY_KIND = {
	automation: 'marketing',
	agent_reply: 'transactional',
} as const satisfies Record<NonCampaignSendKind, SuppressionScope>;

/**
 * The route table each kind resolves against, and the `messageType` the
 * envelope ships. Derived ONCE from the same table so the route resolution,
 * the experiment stream and the envelope's `messageType` cannot drift apart —
 * pre-C2 the producers picked the message type for their upstream route query
 * by hand while the mutation derived the stream separately.
 */
const MESSAGE_TYPE_BY_KIND = {
	automation: 'automation',
	agent_reply: 'transactional',
} as const satisfies Record<NonCampaignSendKind, MessageType>;

const NO_DELIVERY_PROVIDER_DETAIL =
	'No email delivery provider is configured. Set EMAIL_PROVIDER (+ credentials) or a provider route before sending automation or agent mail.';

// ============================================================
// Internal mutation — the intake entry point
// ============================================================

export const intake = internalMutation({
	args: {
		kind: nonCampaignSendKindValidator,
		email: v.string(),
		contactId: v.optional(v.id('contacts')),
		automationId: v.optional(v.id('automations')),
		inboundMessageId: v.optional(v.id('inboundMessages')),
		transactionalEmailId: v.optional(v.id('transactionalEmails')),
		subject: v.string(),
		html: v.string(),
		from: v.string(),
		replyTo: v.optional(v.string()),
		headers: v.optional(v.record(v.string(), v.string())),
		// NO `providerType` / `ipPool` args, deliberately. Both producers used to
		// resolve an ADVISORY route in their own action and hand the answer down
		// — a second resolution of the same message, from a context that could
		// not see the row it was about, whose only consumer is the worker's
		// fallback when its own re-resolution comes back empty. The intake
		// resolves it HERE instead, in the same transaction as the row insert,
		// through the same `resolveSendRouteFromDb` seam the last mile re-runs.
		// Marketing List-Unsubscribe wiring (automation steps only): when set, the
		// worker builds the RFC 8058 one-click header from `contactId` +
		// `convexSiteUrl`. Agent 1:1 replies leave it unset (no List-Unsubscribe
		// on 1:1 mail) but DO carry the RFC 3834 Auto-Submitted anti-loop header
		// stamped by the transactional composer (see below).
		listUnsubscribe: v.optional(v.boolean()),
		convexSiteUrl: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<NonCampaignIntakeOutcome> => {
		const messageType = MESSAGE_TYPE_BY_KIND[args.kind];

		// The shared pre-row gate sequence: abuse → provider-ready → suppression.
		// The `resolved_route` probe makes the provider gate resolve THIS send's
		// route (only once the abuse gate has passed) and judge the exact provider
		// it selected, then hands the resolution back — so the row and the
		// envelope below are stamped from the same resolution the gate judged.
		const gates = await runSendIntakeGates(ctx, {
			email: args.email,
			suppressionScope: SUPPRESSION_SCOPE_BY_KIND[args.kind],
			noDeliveryProviderDetail: NO_DELIVERY_PROVIDER_DETAIL,
			providerReadiness: {
				kind: 'resolved_route',
				messageType,
				to: args.email,
				from: args.from,
			},
		});
		if (!gates.ok) return gates;
		const resolvedRoute = gates.route;

		const sendId = await ctx.db.insert('transactionalSends', {
			kind: args.kind,
			email: args.email,
			status: 'queued',
			queuedAt: Date.now(),
			subject: args.subject,
			...(args.contactId ? { contactId: args.contactId } : {}),
			...(args.automationId ? { automationId: args.automationId } : {}),
			...(args.inboundMessageId ? { inboundMessageId: args.inboundMessageId } : {}),
			...(args.transactionalEmailId ? { transactionalEmailId: args.transactionalEmailId } : {}),
			...(resolvedRoute ? { providerType: resolvedRoute.providerType } : {}),
		});

		// Recipient engagement score for the MTA's enqueue-time priority bands.
		// A single indexed point read HERE, in the enqueue transaction, is the
		// cheap place to pay for it — the dispatch action must never read a
		// contact per send. A send with no contact record (agent replies to an
		// unknown address) does no read at all and carries no score, which the MTA
		// reads as "unknown" rather than "cold".
		//
		// Normalised HERE, at the DB read, so a degenerate stored score never
		// enters the durable envelope (see the campaign producer in `enqueue.ts`).
		const engagementScore = args.contactId
			? normalizeEngagementScore((await ctx.db.get(args.contactId))?.engagementScore)
			: undefined;

		// Gmail FBL — singleton org id anchors the stable `txn`-stream
		// Feedback-ID SenderId for automation + agent-reply sends.
		const organizationId = await ctx.runQuery(
			internal.campaigns.sendQueries.getSingletonOrganizationId,
			{}
		);

		// Experiment record (plan D7), same transaction, before dispatch. An
		// automation step is the `automation` stream; an agent 1:1 reply is
		// `transactional` — the same table the route resolution above read, so the
		// new cell axis and the envelope's shipped `messageType` cannot drift.
		await recordSendAssignments(ctx, {
			organizationId,
			stream: messageType,
			sendKind: 'transactional',
			routing: { messageType, from: args.from },
			// No campaign salt: an automation step or a 1:1 reply is its own
			// single-recipient experiment. The split then salts with the SEND id
			// (`MixRecipientIdentity.fallbackKey`), so the contact's arm is
			// re-drawn on every message instead of being pinned for the life of
			// the mix version — the fixed-cohort bias D7 exists to prevent, and
			// `automation` is a first-class high-volume stream, not an edge.
			recipients: [
				{
					sendId,
					email: args.email,
					...(args.contactId !== undefined ? { contactId: args.contactId } : {}),
				},
			],
		});

		await transactionalEmailPool.enqueueAction(
			ctx,
			internal.delivery.worker.sendSingleEmail,
			{
				envelopeInput: {
					kind: 'transactional' as const,
					deliveryDomain: 'production' as const,
					messageType,
					emailPurpose:
						args.kind === 'automation' ? ('marketing' as const) : ('transactional' as const),
					to: args.email,
					from: args.from,
					replyTo: args.replyTo,
					// ADVISORY ONLY, exactly as before: `delivery/lastMileRouting.ts`
					// re-resolves at dispatch time and reads these two solely as the
					// fallback for an empty re-resolution.
					...(resolvedRoute ? { providerType: resolvedRoute.providerType } : {}),
					...(resolvedRoute?.ipPool ? { ipPool: resolvedRoute.ipPool } : {}),
					sendId,
					template: {
						subject: args.subject,
						htmlContent: args.html,
					},
					// RFC 3834: an agent 1:1 reply IS an automatic reply to a
					// specific inbound message, so it stamps
					// `Auto-Submitted: auto-replied`. Automation steps are not a
					// reply to a message → they keep the composer's default
					// `auto-generated`. Both values are `!= no`, so isAutomatedMail
					// classifies either as automated and the message stays loop-safe.
					...(args.kind === 'agent_reply' ? { autoSubmittedType: 'auto-replied' as const } : {}),
					...(organizationId ? { organizationId } : {}),
					...(args.headers ? { headers: args.headers } : {}),
					...(args.contactId ? { contactId: args.contactId } : {}),
					...(args.listUnsubscribe ? { listUnsubscribe: args.listUnsubscribe } : {}),
					...(args.convexSiteUrl ? { convexSiteUrl: args.convexSiteUrl } : {}),
					...(engagementScore !== undefined ? { engagementScore } : {}),
				},
			},
			{
				onComplete: internal.delivery.sendCompletion.completeSend,
				context: {
					sendRef: { kind: 'transactional' as const, id: sendId },
				},
			}
		);

		return { ok: true, sendId, queued: true };
	},
});
