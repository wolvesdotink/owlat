/**
 * Transactional send intake (module) — single intake path for the public
 * transactional send API.
 *
 * Mirrors the **Form submission (module)** (`forms/submission.ts`) shape:
 * a single internal mutation with a discriminated outcome, dispatching
 * through the **Contact resolution (module)** for find-or-create. Not a
 * lifecycle in the **Outbound lifecycle** sense — every successful intake
 * lands directly in `queued`, and the **Send lifecycle (module)** owns
 * every transition after.
 *
 * Pre-validated input arrives from the HTTP shell at `transactional/api.ts`,
 * which handles JSON-shape validation and attachment storage upload (the
 * latter requires action context for `ctx.storage.store`). The module's
 * args are typed, well-formed data.
 *
 * The refusals and the write plan are decided in `./dispatchDecision.ts`
 * (pure); this mutation reads the facts they need and applies the plan.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { nanoid } from 'nanoid';
import { createContact } from '../contacts/creation';
import { checkEmailDomainVerification } from '../domains/domains';
import { resolveSendRouteFromDb } from '../lib/sendProviders/route';
import { readInstanceCounter, writeInstanceCounter } from '../lib/instanceCounters';
import { enqueueGovernedSend } from '../delivery/governedEnqueue';
import { recordSendAssignments } from '../delivery/sendAssignments';
import { runSendIntakeGates } from '../delivery/sendIntakeGates';
import { jsonPrimitiveValue } from '../lib/convexValidators';
import { getOptional } from '../lib/env';
import { logWarn } from '../lib/runtimeLog';
import { featureDisabledMessage, resolveStoredFeatureFlags } from '../lib/featureFlags';
import { claimPendingUploads } from './pendingUploads';
import {
	IDEMPOTENCY_REFUSAL_MESSAGES,
	idempotencyArgValidator,
	lookupReceipt,
	storedTransactionalResponse,
	writeReceipt,
} from '../auth/apiRequestReceipts';
import type { FeatureFlagState } from '@owlat/shared/featureFlags';
import {
	validateDataVariables,
	resolveLanguage,
	selectContent,
	mergeAttachments,
} from './dispatchContent';
import {
	decideSenderAndVariables,
	decideTemplate,
	planTransactionalSend,
	senderDefaults,
	type DispatchOutcome,
} from './dispatchDecision';

// The outcome types live with the decisions; re-exported for existing importers.
export type { DispatchOutcome, DispatchRejectionReason } from './dispatchDecision';

// Discriminated lookup so the module accepts either a typed id or a slug
// from the HTTP shell without re-validating which was provided.
const templateLookupValidator = v.union(
	v.object({ kind: v.literal('id'), id: v.id('transactionalEmails') }),
	v.object({ kind: v.literal('slug'), slug: v.string() })
);

const attachmentRefValidator = v.object({
	filename: v.string(),
	contentType: v.optional(v.string()),
	url: v.string(),
	storageId: v.optional(v.string()),
});

// The pure content/variable helpers + the AttachmentRef type live in
// ./dispatchContent (kept out of this file so it stays under the file-size
// ratchet). They're re-exported here so existing importers — transactional/api.ts
// and the unit tests — keep a stable path.
export { validateDataVariables, resolveLanguage, selectContent, mergeAttachments };
export type { AttachmentRef } from './dispatchContent';

// ============================================================
// Internal mutation — the intake entry point
// ============================================================

export const dispatch = internalMutation({
	args: {
		templateLookup: templateLookupValidator,
		email: v.string(),
		dataVariables: v.optional(v.record(v.string(), jsonPrimitiveValue)),
		language: v.optional(v.string()),
		// Every `storageId` must be a pending upload the caller registered
		// (`transactional/pendingUploads.ts`); this transaction always claims it.
		attachmentRefs: v.optional(v.array(attachmentRefValidator)),
		// The caller's Idempotency-Key (`auth/apiRequestReceipts.ts`): a repeat
		// of a committed request returns its outcome and sends nothing.
		idempotency: v.optional(idempotencyArgValidator),
	},
	handler: async (ctx, args): Promise<DispatchOutcome> => {
		// 0. Idempotency, before any gate: a request that already committed is
		//    answered from its receipt, and that answer names its original Send.
		//    The request's own uploads stay pending for the shell to release.
		if (args.idempotency) {
			const lookup = await lookupReceipt(ctx, 'transactional', args.idempotency);
			if (lookup.kind === 'refused') {
				return {
					ok: false,
					reason: lookup.reason,
					detail: IDEMPOTENCY_REFUSAL_MESSAGES[lookup.reason],
				};
			}
			if (lookup.kind === 'replay') {
				return {
					ok: true,
					...storedTransactionalResponse(lookup.receipt),
					queued: true,
					replayed: true,
				};
			}
		}

		// 1. The shared pre-row gate sequence (abuse → provider-ready →
		//    suppression, `delivery/sendIntakeGates.ts`) on the settings row read
		//    once here, since the sender defaults and counters need it again.
		//    SUPPRESSION SCOPE `'transactional'`: a bounce or a complaint blocks, a
		//    marketing-hygiene suppression does not, so receipts, password resets
		//    and double-opt-in confirmations still reach someone who ignores the
		//    newsletter.
		const settings = await ctx.db.query('instanceSettings').first();
		// The `transactional` feature floor, resolved from the row just read so
		// the singleton is not fetched twice. Nothing is written while it is off.
		const flags = resolveStoredFeatureFlags((settings?.featureFlags ?? {}) as FeatureFlagState);
		if (!flags.transactional) {
			return {
				ok: false,
				reason: 'feature_disabled',
				detail: featureDisabledMessage('transactional'),
			};
		}
		const gates = await runSendIntakeGates(ctx, {
			email: args.email,
			suppressionScope: 'transactional',
			settings: settings ?? null,
			// The route resolution here is address-aware and needs the sender
			// settled below, so the gate asks the route-INDEPENDENT question — can
			// this message type deliver at all — and the route is resolved later.
			providerReadiness: { kind: 'message_type', messageType: 'transactional' },
			noDeliveryProviderDetail:
				'No email delivery provider is configured. Set EMAIL_PROVIDER (+ credentials) or a provider route before sending transactional email.',
		});
		if (!gates.ok) return gates;

		// 2. Template lookup + publish + has-HTML checks.
		const lookup = args.templateLookup;
		const found = decideTemplate(
			lookup,
			lookup.kind === 'id'
				? await ctx.db.get(lookup.id)
				: await ctx.db
						.query('transactionalEmails')
						.withIndex('by_slug', (q) => q.eq('slug', lookup.slug))
						.first()
		);
		if (!found.ok) return found;
		const { template } = found;
		if (found.isHtmlStale) {
			logWarn(`htmlRenderState.stale at send time for ${template._id}; using cached htmlContent`);
		}

		// 3–4. The sending domain must be verified, then the variables must match.
		const sender = senderDefaults(settings, {
			defaultFromEmail: getOptional('DEFAULT_FROM_EMAIL'),
			defaultFromName: getOptional('DEFAULT_FROM_NAME'),
		});
		const refusal = decideSenderAndVariables({
			domainStatus: await checkEmailDomainVerification(ctx, sender.fromEmail),
			dataVariables: args.dataVariables,
			dataVariablesSchema: template.dataVariablesSchema,
		});
		if (refusal) return refusal;

		// 5. Contact resolution, through the Contact resolution module in
		//    `upsert` mode; the contact is read back for its stored language.
		const resolved = await createContact(ctx, {
			channel: 'email',
			identifier: args.email,
			source: 'transactional',
			mode: 'upsert',
		});
		const contact = await ctx.db.get(resolved.contactId);

		// 6. Provider route resolution, through the shared `resolveSendRoute`
		//    seam. KEPT LATE on purpose: it is address-aware, so it needs the
		//    sender settled above. Its `providerType`/`ipPool` are advisory for the
		//    worker (`delivery/lastMileRouting.ts` re-resolves) but authoritative
		//    for the `providerType` stamped on the row, so it runs before the insert.
		const resolvedRoute = await resolveSendRouteFromDb(ctx, 'transactional', {
			to: args.email,
			from: sender.fromEmail,
		});

		const plan = planTransactionalSend({
			template,
			request: {
				email: args.email,
				language: args.language,
				dataVariables: args.dataVariables,
				attachmentRefs: args.attachmentRefs,
			},
			contactId: resolved.contactId,
			contactLanguage: contact?.language,
			sender,
			route: resolvedRoute,
			sendCounters: settings ? await readInstanceCounter(ctx.db, 'sends') : null,
			// Gmail FBL — singleton org id anchors the stable `txn`-stream
			// Feedback-ID SenderId the worker's transactional composer emits.
			organizationId: await ctx.runQuery(
				internal.campaigns.sendQueries.getSingletonOrganizationId,
				{}
			),
			siteUrl: getOptional('SITE_URL'),
			correlationId: `txn_${nanoid(16)}`,
			now: Date.now(),
		});

		// 7. Ownership of the request's uploaded bytes moves to the row inserted
		//    below, in this transaction. A claim that fails throws, so no Send ever
		//    names a blob the shell released or the expiry sweep freed, and a
		//    caller that stored a blob without registering it is refused.
		if (plan.attachmentStorageIds) {
			await claimPendingUploads(ctx, plan.attachmentStorageIds);
		}

		// 8. The `queued` row and its counters, atomic with each other.
		const sendId = await ctx.db.insert('transactionalSends', plan.sendRow);
		if (plan.counterPatch) await writeInstanceCounter(ctx, 'sends', plan.counterPatch);
		await ctx.db.patch(template._id, plan.templatePatch);

		// 9. Experiment record, inside THIS transaction, before the enqueue. It
		//    does NOT reuse `resolvedRoute`: that resolver is health-influenced and
		//    draws with `Math.random()` under `workload_split`, a draw the worker
		//    repeats, so the writer re-resolves through the health-free cell seam.
		//    The SEND id is the salt, so the arm is re-drawn per message.
		await recordSendAssignments(ctx, {
			organizationId: plan.organizationId,
			stream: 'transactional',
			sendKind: 'transactional',
			routing: { messageType: 'transactional', from: plan.from },
			recipients: [{ sendId, email: args.email, contactId: resolved.contactId }],
		});

		await enqueueGovernedSend(
			ctx,
			{ kind: 'transactional', id: sendId },
			{ envelopeInput: { ...plan.envelope, sendId } }
		);

		const contactCreated = resolved.action === 'created';
		if (args.idempotency) {
			await writeReceipt(ctx, args.idempotency, {
				endpoint: 'transactional',
				contactId: resolved.contactId,
				contactCreated,
				sendId,
				language: plan.language,
			});
		}

		return {
			ok: true,
			sendId,
			contactId: resolved.contactId,
			contactCreated,
			language: plan.language,
			queued: true,
		};
	},
});
