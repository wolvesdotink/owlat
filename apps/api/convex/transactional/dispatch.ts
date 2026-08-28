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
 * See docs/adr/0021-transactional-send-intake-module.md.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { nanoid } from 'nanoid';
import { createContact } from '../contacts/creation';
import { checkEmailDomainVerification } from '../domains/domains';
import { resolveSendRouteFromDb } from '../lib/sendProviders/route';
import { formatFromAddress } from '../lib/emailProviders/domainVerification';
import { nextDailySendCount } from '../lib/sendingLimits';
import { transactionalEmailPool } from '../delivery/workpool';
import { recordSendAssignments } from '../delivery/sendAssignments';
import { runSendIntakeGates, type SendIntakeRejectionReason } from '../delivery/sendIntakeGates';
import { jsonPrimitiveValue } from '../lib/convexValidators';
import { getOptional } from '../lib/env';
import { logWarn } from '../lib/runtimeLog';
import {
	validateDataVariables,
	resolveLanguage,
	selectContent,
	mergeAttachments,
} from './dispatchContent';

// ============================================================
// Public types
// ============================================================

/**
 * Why this intake refused. The first three members are the shared
 * {@link SendIntakeRejectionReason} vocabulary — the same three pre-row gates
 * the **Non-campaign send intake (module)** runs, named once in
 * `delivery/sendIntakeGates.ts` so the two intakes cannot drift into two
 * spellings of one refusal. The rest are this intake's own: only the Template
 * API takes a stored template and caller-supplied variables.
 */
export type DispatchRejectionReason =
	| SendIntakeRejectionReason
	| 'template_not_found'
	| 'template_not_published'
	| 'template_no_content'
	| 'domain_unverified'
	| 'invalid_variables';

export type DispatchOutcome =
	| {
			ok: true;
			sendId: Id<'transactionalSends'>;
			contactId: Id<'contacts'>;
			contactCreated: boolean;
			language: string;
			queued: true;
	  }
	| {
			ok: false;
			reason: DispatchRejectionReason;
			detail?: string;
	  };

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
		attachmentRefs: v.optional(v.array(attachmentRefValidator)),
	},
	handler: async (ctx, args): Promise<DispatchOutcome> => {
		// 1. The shared pre-row gate sequence: abuse → provider-ready →
		//    suppression, owned by `delivery/sendIntakeGates.ts` (pre-deepening
		//    the abuse check lived as `isSendingAllowed` on the HTTP shell against
		//    a separately-fetched instanceSettings). Every refusal is returned as
		//    a typed rejection and leaves no row behind.
		//
		//    `settings` is read HERE and handed down because this intake needs the
		//    same row again for its sender defaults and counters; the gate must
		//    not read the singleton a second time.
		//
		//    SUPPRESSION SCOPE `'transactional'`: a bounce or a complaint still
		//    blocks, but a MARKETING-hygiene suppression does not. A customer who
		//    ignores the newsletter has not asked to stop receiving their
		//    receipts, their password resets or the double-opt-in confirmation
		//    they just requested — and blocking the confirmation would make
		//    consent itself unreachable.
		const settings = await ctx.db.query('instanceSettings').first();
		const gates = await runSendIntakeGates(ctx, {
			email: args.email,
			suppressionScope: 'transactional',
			settings: settings ?? null,
			// The Template API's route resolution is address-aware and needs a
			// `from` that is only settled by step 3 below, so the gate asks the
			// route-INDEPENDENT question — can this message type deliver at all —
			// and this intake resolves its own route later (step 7).
			providerReadiness: { kind: 'message_type', messageType: 'transactional' },
			noDeliveryProviderDetail:
				'No email delivery provider is configured. Set EMAIL_PROVIDER (+ credentials) or a provider route before sending transactional email.',
		});
		if (!gates.ok) return gates;

		// 2. Template lookup + publish + has-HTML checks.
		let template: Doc<'transactionalEmails'> | null = null;
		if (args.templateLookup.kind === 'id') {
			template = await ctx.db.get(args.templateLookup.id);
			if (!template) {
				return {
					ok: false,
					reason: 'template_not_found',
					detail: `Transactional email with ID "${args.templateLookup.id}" not found`,
				};
			}
		} else {
			const slug = args.templateLookup.slug;
			template = await ctx.db
				.query('transactionalEmails')
				.withIndex('by_slug', (q) => q.eq('slug', slug))
				.first();
			if (!template) {
				return {
					ok: false,
					reason: 'template_not_found',
					detail: `Transactional email with slug "${slug}" not found`,
				};
			}
		}

		if (template.status !== 'published') {
			return {
				ok: false,
				reason: 'template_not_published',
				detail: `Transactional email "${template.slug}" is not published. Please publish it before sending.`,
			};
		}

		if (!template.htmlContent) {
			return {
				ok: false,
				reason: 'template_no_content',
				detail: `Transactional email "${template.slug}" has no HTML content. Please save and publish it first.`,
			};
		}

		// Per ADR-0023, log (do not gate) when sending against stale HTML — a
		// saved-block edit propagated to the consumer's content JSON but the
		// rerender pool has not yet caught up. Cached `htmlContent` is used.
		if (template.htmlRenderState?.stale) {
			logWarn(`htmlRenderState.stale at send time for ${template._id}; using cached htmlContent`);
		}

		// 3. Sender + domain verification. Resolve `defaultFromEmail` from
		//    settings → env → fallback; verify the sending domain is registered
		//    and currently `verified`.
		const defaultFromEmail =
			settings?.defaultFromEmail ?? getOptional('DEFAULT_FROM_EMAIL') ?? 'noreply@example.com';
		const defaultFromName =
			settings?.defaultFromName ?? getOptional('DEFAULT_FROM_NAME') ?? 'Owlat';

		const domainStatus = await checkEmailDomainVerification(ctx, defaultFromEmail);
		if (!domainStatus.verified) {
			return {
				ok: false,
				reason: 'domain_unverified',
				detail:
					domainStatus.error ||
					`Cannot send transactional email: domain "${domainStatus.domain}" is not verified. Please verify this domain in Settings > Domains.`,
			};
		}

		// 4. Validate `dataVariables` shape against the template's declared schema.
		const variableValidation = validateDataVariables(
			args.dataVariables,
			template.dataVariablesSchema
		);
		if (!variableValidation.valid) {
			return {
				ok: false,
				reason: 'invalid_variables',
				detail: variableValidation.error,
			};
		}

		// 5. Contact resolution. Routes through the Contact resolution module
		//    in `upsert` mode — closes the open-coded find-or-create with
		//    race-retry try/catch hack at the pre-deepening transactionalApiHttp.ts.
		const resolved = await createContact(ctx, {
			channel: 'email',
			identifier: args.email,
			source: 'transactional',
			mode: 'upsert',
		});

		// 6. Language resolution. Read the contact (post-upsert) so the
		//    fallback chain (request → contact → template default → 'en')
		//    can consider the contact's stored language. The upsert never
		//    overwrites contact.language, so a pre-existing value wins.
		const contact = await ctx.db.get(resolved.contactId);
		const supportedLanguages = template.supportedLanguages ?? [template.defaultLanguage ?? 'en'];
		const language = resolveLanguage(
			args.language,
			contact?.language,
			template.defaultLanguage,
			supportedLanguages
		);

		const {
			html: htmlContentToSend,
			subject: subjectToSend,
			resolvedLanguage,
		} = selectContent(
			language,
			template.defaultLanguage ?? 'en',
			template.htmlContent,
			template.subject,
			template.htmlTranslations
		);

		// The pre-generated text/plain body belongs to the DEFAULT language only —
		// translations carry no translated text body, and pairing the default
		// language's text with translated html would send two languages in one
		// message. Absent → the composer strips the untracked html instead.
		const plainTextToSend =
			resolvedLanguage === (template.defaultLanguage ?? 'en')
				? template.plainTextContent
				: undefined;

		// 7. Provider route resolution. Reads the route config + health
		//    snapshots in-transaction via the shared `resolveSendRoute` seam.
		//
		//    KEPT HERE, and kept LATE, on purpose. The sibling non-campaign
		//    intake resolves its route up in the provider gate; this one cannot,
		//    because the resolution is address-aware and `defaultFromEmail` is
		//    only settled by step 4 above. The `providerType`/`ipPool` it yields
		//    are advisory for the worker either way (`delivery/lastMileRouting.ts`
		//    re-resolves and reads them only as the fallback), but they are
		//    authoritative for the `providerType` stamped on the row below, so
		//    this must run before the insert.
		const resolvedRoute = await resolveSendRouteFromDb(ctx, 'transactional', {
			to: args.email,
			from: defaultFromEmail,
		});

		// 8. Template + request attachment merge.
		const mergedAttachments = mergeAttachments(template.attachments, args.attachmentRefs);
		const attachmentStorageIds = args.attachmentRefs
			?.filter((a) => a.storageId)
			.map((a) => a.storageId!);

		// 9. Insert `transactionalSends` row in `queued`. Writes the resolved
		//     language onto the row — pre-deepening this lived on the API
		//     response only.
		const correlationId = `txn_${nanoid(16)}`;
		const now = Date.now();
		const sendId = await ctx.db.insert('transactionalSends', {
			kind: 'transactional' as const,
			transactionalEmailId: template._id,
			email: args.email,
			contactId: resolved.contactId,
			language: resolvedLanguage,
			dataVariables: args.dataVariables,
			status: 'queued',
			queuedAt: now,
			...(resolvedRoute ? { providerType: resolvedRoute.providerType } : {}),
			correlationId,
			...(attachmentStorageIds && attachmentStorageIds.length > 0 ? { attachmentStorageIds } : {}),
		});

		// 10. Counter increments — all atomic with the row insert.
		//     Pre-deepening the daily counter fired from the HTTP shell
		//     *after* the enqueue mutation returned; consolidating into
		//     `dispatch` closes the drift seam. The per-template `sendCount`
		//     denormalization replaces the N+1 scan that `transactional.sends.getCounts`
		//     used to do over `transactionalSends` per template.
		// Single instanceSettings patch — transactional + daily counters together
		// — so the latency-sensitive transactional send RMWs the config singleton
		// once instead of twice (the daily counter used to re-fetch + patch it
		// separately, doubling the OCC pressure on one row).
		if (settings) {
			await ctx.db.patch(settings._id, {
				transactionalSendCount: (settings.transactionalSendCount ?? 0) + 1,
				...nextDailySendCount(settings, 1, Date.now()),
			});
		}
		await ctx.db.patch(template._id, {
			sendCount: (template.sendCount ?? 0) + 1,
		});

		// 11. Enqueue workpool.
		const from = formatFromAddress(defaultFromEmail, defaultFromName);
		// Gmail FBL — singleton org id anchors the stable `txn`-stream
		// Feedback-ID SenderId the worker's transactional composer emits.
		const organizationId = await ctx.runQuery(
			internal.campaigns.sendQueries.getSingletonOrganizationId,
			{}
		);

		// Experiment record (plan D7): the Template API is the primary producer
		// of the `transactional` stream, so its cell axis would otherwise be
		// populated only by agent 1:1 replies. Written inside THIS transaction,
		// before the workpool enqueue.
		//
		// It deliberately does NOT reuse `resolvedRoute` from step 7. That one
		// comes from the authoritative per-message resolver, which is
		// health-influenced and draws with `Math.random()` under
		// `workload_split` — a draw the worker repeats independently at
		// dispatch. Recording it would file a coin flip, under a second
		// resolution semantics, into the same `transactional:*` cells the other
		// producers fill from the health-free cell seam. The writer re-resolves
		// through that one seam instead, which is also where the
		// non-deterministic-strategy gate lives.
		await recordSendAssignments(ctx, {
			organizationId,
			stream: 'transactional',
			sendKind: 'transactional',
			routing: { messageType: 'transactional', from },
			// No campaign salt: a transactional send is its own single-recipient
			// experiment. The contact id is the stable per-recipient identity and
			// the SEND id is the salt, so the arm is re-drawn per message rather
			// than pinning the contact to one arm forever (plan D7).
			recipients: [{ sendId, email: args.email, contactId: resolved.contactId }],
		});

		await transactionalEmailPool.enqueueAction(
			ctx,
			internal.delivery.worker.sendSingleEmail,
			{
				envelopeInput: {
					kind: 'transactional' as const,
					emailPurpose: 'transactional' as const,
					to: args.email,
					from,
					...(resolvedRoute ? { providerType: resolvedRoute.providerType } : {}),
					...(resolvedRoute?.ipPool ? { ipPool: resolvedRoute.ipPool } : {}),
					sendId,
					template: {
						subject: subjectToSend,
						htmlContent: htmlContentToSend,
						...(plainTextToSend ? { plainTextContent: plainTextToSend } : {}),
					},
					dataVariables: args.dataVariables,
					attachmentRefs: mergedAttachments,
					...(organizationId ? { organizationId } : {}),
					// Unsubscribe footer — the worker builds the HMAC URLs from
					// `siteUrl` + `contactId` only when the template opts in.
					...(template.showUnsubscribe
						? {
								showUnsubscribe: true,
								contactId: resolved.contactId,
								siteUrl: getOptional('SITE_URL') || undefined,
							}
						: {}),
				},
			},
			{
				onComplete: internal.delivery.sendCompletion.completeSend,
				context: {
					sendRef: { kind: 'transactional' as const, id: sendId },
				},
			}
		);

		return {
			ok: true,
			sendId,
			contactId: resolved.contactId,
			contactCreated: resolved.action === 'created',
			language: resolvedLanguage,
			queued: true,
		};
	},
});
