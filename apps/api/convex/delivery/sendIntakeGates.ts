/**
 * Send intake gates (module) — the ONE pre-row gate sequence every send
 * intake runs, in one fixed order: **abuse → provider-ready → suppression**.
 *
 * Both intakes that write a `transactionalSends` row from an outside request
 * share it: the Template API intake (`transactional/dispatch.ts`) and the
 * non-campaign intake (`delivery/nonCampaignIntake.ts`, automation steps +
 * agent approved-replies). Before this module the two ran the same three
 * checks in the same order with two different POLICIES — dispatch returned a
 * typed `{ ok: false, reason }`, the non-campaign producer threw a bare
 * `Error('recipient_blocked')` from an exported magic-string constant that two
 * call sites re-classified by string-matching `error.message`. The gate order
 * and the refusal vocabulary now live here once, and every intake returns the
 * typed rejection.
 *
 * Every gate is PRE-ROW by construction: it runs before any insert, so a
 * refusal leaves no `transactionalSends` row, no `sendAssignments` row and no
 * workpool job behind. That is the whole reason the sequence is a module and
 * not three inline checks — it is the property that makes a refusal safe to
 * treat as final rather than as a failed send to retry.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { isSendingAllowed } from '../workspaces/abuseGate';
import { isSuppressed, type SuppressionScope } from '../lib/suppression';
import { isDeliveryConfigured, selectedSendProviderReady } from '../lib/sendProviders/capability';
import { resolveSendRouteFromDb, type MessageType } from '../lib/sendProviders/route';
import type { ResolvedRoute } from '../lib/sendProviders/routing';

/**
 * Why an intake refused BEFORE writing a row.
 *
 * Every member is PERMANENT for this attempt — nothing here clears by trying
 * again in a moment — which is what lets the callers treat a rejection as a
 * terminal outcome instead of feeding it to a retry loop. Transient refusals
 * (an open delivery circuit, an unverified fallback relay) are NOT in this
 * union: they surface as routing deferrals from the send path itself, which is
 * where the bounded retry lives.
 */
export type SendIntakeRejectionReason =
	| 'abuse_blocked'
	| 'no_delivery_provider'
	| 'recipient_blocked';

/**
 * The `{ ok: false }` half of an intake outcome. Generic over the reason so an
 * intake with reasons of its own — the Template API also refuses for template
 * and variable problems — can widen the union without redeclaring the shape.
 */
export type SendIntakeRejection<Reason extends string = SendIntakeRejectionReason> = {
	ok: false;
	reason: Reason;
	detail?: string;
};

/**
 * How an intake wants "is a delivery provider ready?" answered. The two forms
 * are not interchangeable, and the choice is a property of the intake:
 *
 *   - `message_type` — the route-independent question: can this message type
 *     deliver at all? The Template API takes this one because its route
 *     resolution is address-aware and its `from` address is not settled until
 *     several steps after the gates.
 *   - `resolved_route` — resolve the route this exact send would take, then
 *     ask about the provider it selected. The non-campaign intake takes this
 *     one, and {@link SendIntakeGatesPassed.route} hands the resolution back so
 *     the row and the envelope are stamped from the SAME resolution the gate
 *     judged, never a second one.
 */
export type ProviderReadinessProbe =
	| { kind: 'message_type'; messageType: MessageType }
	| { kind: 'resolved_route'; messageType: MessageType; to: string; from: string };

/** The gates passed. `route` is non-null only for a `resolved_route` probe. */
export interface SendIntakeGatesPassed {
	ok: true;
	route: ResolvedRoute | null;
}

/** What {@link runSendIntakeGates} needs to answer the three questions. */
export interface SendIntakeGateInput {
	/** The recipient address the suppression gate reads. */
	email: string;
	/**
	 * Which {@link SuppressionScope} THIS kind of mail is gated at. There is no
	 * default: marketing mail must take the strict scope and a 1:1 answer to a
	 * human must not be thrown away by a marketing-hygiene row, and a caller
	 * that has not thought about which it is has no business sending.
	 */
	suppressionScope: SuppressionScope;
	/** @see ProviderReadinessProbe */
	providerReadiness: ProviderReadinessProbe;
	/**
	 * `instanceSettings` when the caller has already read it (the Template API
	 * intake needs the row for its sender defaults and counters, and must not
	 * pay for a second read). Omit it and the gate reads the singleton itself;
	 * pass `null` to say "already read, and there is no row".
	 */
	settings?: Doc<'instanceSettings'> | null;
	/** Operator-facing text for the `no_delivery_provider` rejection. */
	noDeliveryProviderDetail: string;
}

/**
 * Run the three shared gates in order. Returns the typed rejection, or the
 * passed marker carrying whatever the provider probe resolved.
 *
 * The ORDER is load-bearing and is why this is one function rather than three
 * exported predicates: the cheapest and most absolute refusal answers first (a
 * suspended instance sends nothing at all), then the deployment-wide one (no
 * provider ⇒ every send would fail in the worker), and only then the
 * per-recipient one. Reversing any pair would spend reads deciding about a
 * recipient for a deployment that cannot send, and would report the narrower
 * reason for the broader problem. The provider probe runs only once the abuse
 * gate has passed, so a suspended instance pays for no route reads.
 */
export async function runSendIntakeGates(
	ctx: MutationCtx,
	input: SendIntakeGateInput
): Promise<SendIntakeRejection | SendIntakeGatesPassed> {
	// 1. Abuse gate. A suspended or banned instance sends nothing.
	const settings =
		input.settings !== undefined ? input.settings : await ctx.db.query('instanceSettings').first();
	if (!isSendingAllowed(settings?.abuseStatus ?? null)) {
		return { ok: false, reason: 'abuse_blocked' };
	}

	// 2. Delivery-provider gate. Refuse at intake rather than queue a row that
	//    could never deliver and would march to `failed` in the worker.
	const probe = await probeProviderReadiness(ctx, input.providerReadiness);
	if (!probe.isReady) {
		return {
			ok: false,
			reason: 'no_delivery_provider',
			detail: input.noDeliveryProviderDetail,
		};
	}

	// 3. Suppression gate. The shared `isSuppressed` owns the normalization +
	//    `by_email` point read; the SCOPE is the caller's per-kind decision.
	if (await isSuppressed(ctx, input.email, { scope: input.suppressionScope })) {
		return { ok: false, reason: 'recipient_blocked' };
	}

	return { ok: true, route: probe.route };
}

async function probeProviderReadiness(
	ctx: MutationCtx,
	probe: ProviderReadinessProbe
): Promise<{ isReady: boolean; route: ResolvedRoute | null }> {
	if (probe.kind === 'message_type') {
		return { isReady: await isDeliveryConfigured(ctx, probe.messageType), route: null };
	}
	// A null resolution means neither a route table nor the `EMAIL_PROVIDER`
	// fallback yields a ready transport, which `selectedSendProviderReady`
	// (called with `undefined`) then reports as not-ready — the same verdict the
	// pre-C2 producers reached with their own `if (!route)` check on the
	// advisory resolution they ran in their own action.
	const route = await resolveSendRouteFromDb(ctx, probe.messageType, {
		to: probe.to,
		from: probe.from,
	});
	return { isReady: await selectedSendProviderReady(ctx, route?.providerType), route };
}
