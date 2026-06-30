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
import { isSendingAllowed } from '../organizations/abuseGate';
import { checkEmailDomainVerification } from '../domains/domains';
import { resolveSendRouteFromDb } from '../lib/sendProviders/route';
import { isDeliveryConfigured } from '../lib/sendProviders/capability';
import { formatFromAddress } from '../lib/emailProviders/domainVerification';
import { nextDailySendCount } from '../lib/sendingLimits';
import { transactionalEmailPool } from '../delivery/workpool';
import { jsonPrimitiveValue } from '../lib/convexValidators';
import { getOptional } from '../lib/env';
import { logWarn } from '../lib/runtimeLog';
import { isSuppressed } from '../lib/suppression';

// ============================================================
// Public types
// ============================================================

export type DispatchRejectionReason =
	| 'abuse_blocked'
	| 'no_delivery_provider'
	| 'recipient_blocked'
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
	v.object({ kind: v.literal('slug'), slug: v.string() }),
);

const attachmentRefValidator = v.object({
	filename: v.string(),
	contentType: v.optional(v.string()),
	url: v.string(),
	storageId: v.optional(v.string()),
});

export type AttachmentRef = {
	filename: string;
	contentType?: string;
	url: string;
	storageId?: string;
};

// ============================================================
// Helpers (exported for unit testing)
// ============================================================

/**
 * Validate request `dataVariables` against the template's declared
 * `dataVariablesSchema`. Returns `{ valid: true }` when no schema is
 * declared or all provided values match; `{ valid: false, error }` on
 * type mismatch. Ported from the pre-deepening `transactionalApiHttp.ts`.
 *
 * Returns a plain shape `{ valid: boolean; error?: string }` (rather than a
 * strict discriminated union) so callers and tests can read `result.error`
 * without TypeScript narrowing ceremony.
 */
export function validateDataVariables(
	variables: Record<string, unknown> | undefined,
	schema: Record<string, string> | undefined,
): { valid: boolean; error?: string } {
	if (!schema) return { valid: true };
	if (!variables) return { valid: true };

	for (const [key, expectedType] of Object.entries(schema)) {
		const value = variables[key];
		if (value === undefined || value === null) continue;

		const actualType = typeof value;
		let isValid = false;

		switch (expectedType) {
			case 'string':
				isValid = actualType === 'string';
				break;
			case 'number':
				isValid = actualType === 'number' && !isNaN(value as number);
				break;
			case 'boolean':
				isValid = actualType === 'boolean';
				break;
			case 'date':
				isValid =
					(actualType === 'string' || actualType === 'number') &&
					!isNaN(new Date(value as string | number).getTime());
				break;
			default:
				isValid = true;
		}

		if (!isValid) {
			return {
				valid: false,
				error: `Variable "${key}" should be of type "${expectedType}", got "${actualType}"`,
			};
		}
	}

	return { valid: true };
}

/**
 * Resolve which language the send should use. Fallback chain:
 *   request → contact → template default → 'en'
 *
 * The resolved language is then used to pick `htmlContent` + `subject`
 * from `htmlTranslations[lang]` (via {@link selectContent}). If the
 * picked language has no translation, the template's default
 * content is used and the resolved language drops back to the default.
 */
export function resolveLanguage(
	requestLanguage: string | undefined,
	contactLanguage: string | undefined,
	templateDefaultLanguage: string | undefined,
	availableLanguages: string[],
): string {
	const fallback = templateDefaultLanguage ?? 'en';
	const candidate = requestLanguage ?? contactLanguage ?? fallback;
	if (candidate === fallback) return fallback;
	return availableLanguages.includes(candidate) ? candidate : fallback;
}

/**
 * Pick `htmlContent` + `subject` for the resolved language from the
 * template's `htmlTranslations` JSON (or fall back to the default
 * top-level fields). Invalid JSON is treated as no translations.
 */
export function selectContent(
	language: string,
	templateDefaultLanguage: string,
	defaultHtmlContent: string,
	defaultSubject: string,
	htmlTranslationsJson: string | undefined,
): { html: string; subject: string; resolvedLanguage: string } {
	if (language === templateDefaultLanguage || !htmlTranslationsJson) {
		return {
			html: defaultHtmlContent,
			subject: defaultSubject,
			resolvedLanguage: templateDefaultLanguage,
		};
	}

	try {
		const translations = JSON.parse(htmlTranslationsJson) as Record<
			string,
			{ htmlContent: string; subject: string }
		>;
		const picked = translations[language];
		if (picked) {
			return {
				html: picked.htmlContent,
				subject: picked.subject,
				resolvedLanguage: language,
			};
		}
	} catch {
		// Invalid JSON in translations — fall through to the default content.
	}

	return {
		html: defaultHtmlContent,
		subject: defaultSubject,
		resolvedLanguage: templateDefaultLanguage,
	};
}

/**
 * Merge template-side attachments (parsed from the template's `attachments`
 * JSON blob) with request-side attachments (already resolved by the HTTP
 * shell). Template attachments come first; request attachments are appended.
 * Invalid JSON on the template side is treated as no template attachments.
 */
export function mergeAttachments(
	templateAttachmentsJson: string | undefined,
	requestAttachments: AttachmentRef[] | undefined,
): { filename: string; contentType?: string; url: string }[] | undefined {
	let templateAttachments: { filename: string; contentType?: string; url: string }[] = [];

	if (templateAttachmentsJson) {
		try {
			const parsed = JSON.parse(templateAttachmentsJson) as {
				filename: string;
				contentType?: string;
				url: string;
			}[];
			templateAttachments = parsed.map((a) => ({
				filename: a.filename,
				contentType: a.contentType,
				url: a.url,
			}));
		} catch {
			// Invalid JSON — ignore template attachments.
		}
	}

	const requestStripped = (requestAttachments ?? []).map((a) => ({
		filename: a.filename,
		contentType: a.contentType,
		url: a.url,
	}));

	const merged = [...templateAttachments, ...requestStripped];
	return merged.length > 0 ? merged : undefined;
}

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
		// 1. Abuse gate. Pre-deepening this lived as `isSendingAllowed` on
		//    the HTTP shell against a separately-fetched instanceSettings.
		const settings = await ctx.db.query('instanceSettings').first();
		if (!isSendingAllowed(settings?.abuseStatus ?? null)) {
			return { ok: false, reason: 'abuse_blocked' };
		}

		// 1b. Reject at intake (HTTP 4xx, no row) when no delivery provider is set.
		if (!(await isDeliveryConfigured(ctx, 'transactional'))) {
			return { ok: false, reason: 'no_delivery_provider', detail: 'No email delivery provider is configured. Set EMAIL_PROVIDER (+ credentials) or a provider route before sending transactional email.' };
		}
		// 2. Blocklist. The shared `isSuppressed` owns the normalization +
		//    `by_email` point read (the HTTP shell already lowercases + trims,
		//    so the re-normalization is a defensive no-op). This path's POLICY
		//    is to RETURN a typed rejection rather than throw.
		if (await isSuppressed(ctx, args.email)) {
			return { ok: false, reason: 'recipient_blocked' };
		}

		// 3. Template lookup + publish + has-HTML checks.
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
			logWarn(
				`htmlRenderState.stale at send time for ${template._id}; using cached htmlContent`,
			);
		}

		// 4. Sender + domain verification. Resolve `defaultFromEmail` from
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

		// 5. Validate `dataVariables` shape against the template's declared schema.
		const variableValidation = validateDataVariables(
			args.dataVariables,
			template.dataVariablesSchema,
		);
		if (!variableValidation.valid) {
			return {
				ok: false,
				reason: 'invalid_variables',
				detail: variableValidation.error,
			};
		}

		// 6. Contact resolution. Routes through the Contact resolution module
		//    in `upsert` mode — closes the open-coded find-or-create with
		//    race-retry try/catch hack at the pre-deepening transactionalApiHttp.ts.
		const resolved = await createContact(ctx, {
			channel: 'email',
			identifier: args.email,
			source: 'transactional',
			mode: 'upsert',
		});

		// 7. Language resolution. Read the contact (post-upsert) so the
		//    fallback chain (request → contact → template default → 'en')
		//    can consider the contact's stored language. The upsert never
		//    overwrites contact.language, so a pre-existing value wins.
		const contact = await ctx.db.get(resolved.contactId);
		const supportedLanguages = template.supportedLanguages ?? [template.defaultLanguage ?? 'en'];
		const language = resolveLanguage(
			args.language,
			contact?.language,
			template.defaultLanguage,
			supportedLanguages,
		);

		const { html: htmlContentToSend, subject: subjectToSend, resolvedLanguage } = selectContent(
			language,
			template.defaultLanguage ?? 'en',
			template.htmlContent,
			template.subject,
			template.htmlTranslations,
		);

		// 8. Provider route resolution. Reads the route config + health
		//    snapshots in-transaction via the shared `resolveSendRoute` seam.
		const resolvedRoute = await resolveSendRouteFromDb(ctx, 'transactional');

		// 9. Template + request attachment merge.
		const mergedAttachments = mergeAttachments(template.attachments, args.attachmentRefs);
		const attachmentStorageIds = args.attachmentRefs
			?.filter((a) => a.storageId)
			.map((a) => a.storageId!);

		// 10. Insert `transactionalSends` row in `queued`. Writes the resolved
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
			...(attachmentStorageIds && attachmentStorageIds.length > 0
				? { attachmentStorageIds }
				: {}),
		});

		// 11. Counter increments — all atomic with the row insert.
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

		// 12. Enqueue workpool.
		const from = formatFromAddress(defaultFromEmail, defaultFromName);
		// Gmail FBL — singleton org id anchors the stable `txn`-stream
		// Feedback-ID SenderId the worker's transactional composer emits.
		const organizationId = await ctx.runQuery(
			internal.campaigns.sendQueries.getSingletonOrganizationId,
			{},
		);
		await transactionalEmailPool.enqueueAction(
			ctx,
			internal.delivery.worker.sendSingleEmail,
			{
				envelopeInput: {
					kind: 'transactional' as const,
					to: args.email,
					from,
					...(resolvedRoute ? { providerType: resolvedRoute.providerType } : {}),
					sendId,
					template: {
						subject: subjectToSend,
						htmlContent: htmlContentToSend,
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
			},
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
