/**
 * The transactional intake's decisions, without the database: which refusal a
 * request meets (in order: template, sender domain, variables), and, once it
 * passes, the plan one transaction writes — the `queued` Send row, the
 * counter and template patches, the uploads to claim and the worker envelope.
 * `dispatch.ts` reads the facts, runs the shared intake gates and contact
 * resolution, and applies the plan; ids, the clock and the correlation id
 * come in as inputs.
 *
 * PURE: nothing here reads a clock, a database or the environment
 * (scripts/purity-roots.txt).
 */

import type { WithoutSystemFields } from 'convex/server';
import type { Infer } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { IdempotencyRefusalReason } from '../auth/apiRequestReceipts';
import type { SendIntakeRejectionReason } from '../delivery/sendIntakeGates';
import type { WorkerEnvelopeInput } from '../delivery/workerEnvelope';
import type { jsonPrimitiveRecord } from '../lib/convexValidators';
import { formatFromAddress } from '../lib/emailProviders/domainVerification';
import { nextDailySendCount } from '../lib/sendingLimits';
import {
	mergeAttachments,
	resolveLanguage,
	selectContent,
	validateDataVariables,
	type AttachmentRef,
} from './dispatchContent';

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
	| 'feature_disabled'
	| 'template_not_found'
	| 'template_not_published'
	| 'template_no_content'
	| 'domain_unverified'
	| 'invalid_variables'
	| IdempotencyRefusalReason;

export type DispatchRefusal = {
	ok: false;
	reason: DispatchRejectionReason;
	detail?: string;
};

export type DispatchOutcome =
	| {
			ok: true;
			sendId: Id<'transactionalSends'>;
			contactId: Id<'contacts'>;
			contactCreated: boolean;
			language: string;
			queued: true;
			/** Answered from the Idempotency-Key's receipt: nothing was sent this time. */
			replayed?: true;
	  }
	| DispatchRefusal;

export type TemplateLookup =
	| { readonly kind: 'id'; readonly id: Id<'transactionalEmails'> }
	| { readonly kind: 'slug'; readonly slug: string };

type Template = Doc<'transactionalEmails'>;

/**
 * The template's lookup, publish and has-HTML checks. A template sent while
 * its HTML is stale (a saved-block edit not yet re-rendered) is not refused:
 * the cached HTML is used and the shell logs it.
 */
export function decideTemplate(
	lookup: TemplateLookup,
	template: Template | null
): DispatchRefusal | { ok: true; template: Template; isHtmlStale: boolean } {
	if (!template) {
		return {
			ok: false,
			reason: 'template_not_found',
			detail:
				lookup.kind === 'id'
					? `Transactional email with ID "${lookup.id}" not found`
					: `Transactional email with slug "${lookup.slug}" not found`,
		};
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
	return { ok: true, template, isHtmlStale: template.htmlRenderState?.stale === true };
}

/** The sender every transactional send uses: settings → environment → fallback. */
export function senderDefaults(
	settings: Pick<Doc<'instanceSettings'>, 'defaultFromEmail' | 'defaultFromName'> | null,
	environment: { readonly defaultFromEmail?: string; readonly defaultFromName?: string }
): { fromEmail: string; fromName: string } {
	return {
		fromEmail: settings?.defaultFromEmail ?? environment.defaultFromEmail ?? 'noreply@example.com',
		fromName: settings?.defaultFromName ?? environment.defaultFromName ?? 'Owlat',
	};
}

/**
 * The refusals left once the template is known, in order: the sending domain
 * must be registered and verified, then `dataVariables` must match the
 * template's declared schema.
 */
export function decideSenderAndVariables(input: {
	readonly domainStatus: {
		readonly verified: boolean;
		readonly domain: string;
		readonly error?: string;
	};
	readonly dataVariables: Record<string, unknown> | undefined;
	readonly dataVariablesSchema: Template['dataVariablesSchema'];
}): DispatchRefusal | undefined {
	if (!input.domainStatus.verified) {
		return {
			ok: false,
			reason: 'domain_unverified',
			detail:
				input.domainStatus.error ||
				`Cannot send transactional email: domain "${input.domainStatus.domain}" is not verified. Please verify this domain in Settings > Domains.`,
		};
	}
	const validation = validateDataVariables(input.dataVariables, input.dataVariablesSchema);
	if (!validation.valid) {
		return { ok: false, reason: 'invalid_variables', detail: validation.error };
	}
	return undefined;
}

/** What one accepted request writes and queues, in one transaction. */
export interface TransactionalSendPlan {
	/** The language the content was picked in, after the translation fallback. */
	readonly language: string;
	/** Request uploads whose ownership moves to the Send row (claimed before the insert). */
	readonly attachmentStorageIds: string[] | undefined;
	readonly sendRow: WithoutSystemFields<Doc<'transactionalSends'>>;
	/** The `sends` counter patch, or `undefined` before the instance exists. */
	readonly counterPatch:
		| { transactionalSendCount: number; dailySendCount: number; dailySendCountResetAt: number }
		| undefined;
	readonly templatePatch: { sendCount: number };
	/** The routing `from` the experiment record and the envelope carry. */
	readonly from: string;
	/** The deployment's organization, for the experiment record and the Feedback-ID. */
	readonly organizationId: string | null;
	/** The worker envelope, completed with the inserted row's id. */
	readonly envelope: Omit<Extract<WorkerEnvelopeInput, { kind: 'transactional' }>, 'sendId'>;
}

export function planTransactionalSend(input: {
	readonly template: Template;
	readonly request: {
		readonly email: string;
		readonly language: string | undefined;
		readonly dataVariables: Infer<typeof jsonPrimitiveRecord> | undefined;
		readonly attachmentRefs: AttachmentRef[] | undefined;
	};
	readonly contactId: Id<'contacts'>;
	readonly contactLanguage: string | undefined;
	readonly sender: { readonly fromEmail: string; readonly fromName: string };
	readonly route: { readonly providerType: string; readonly ipPool?: string } | null;
	/** The `sends` counter row, or `null` when there is no instance settings row yet. */
	readonly sendCounters: Pick<
		Doc<'instanceSettings'>,
		'transactionalSendCount' | 'dailySendCount' | 'dailySendCountResetAt'
	> | null;
	readonly organizationId: string | null;
	readonly siteUrl: string | undefined;
	readonly correlationId: string;
	readonly now: number;
}): TransactionalSendPlan {
	const { template, request, route } = input;
	const defaultLanguage = template.defaultLanguage ?? 'en';
	// Fallback chain: request → contact → template default → 'en'. The contact
	// upsert never overwrites a stored language, so a pre-existing one wins.
	const language = resolveLanguage(
		request.language,
		input.contactLanguage,
		template.defaultLanguage,
		template.supportedLanguages ?? [defaultLanguage]
	);
	const content = selectContent(
		language,
		defaultLanguage,
		template.htmlContent ?? '',
		template.subject,
		template.htmlTranslations
	);
	// The pre-generated text/plain body belongs to the DEFAULT language only —
	// translations carry no translated text body, and pairing the default
	// language's text with translated html would send two languages in one
	// message. Absent → the composer strips the untracked html instead.
	const plainText =
		content.resolvedLanguage === defaultLanguage ? template.plainTextContent : undefined;
	const attachmentStorageIds = request.attachmentRefs
		?.filter((a) => a.storageId)
		.map((a) => a.storageId!);
	const from = formatFromAddress(input.sender.fromEmail, input.sender.fromName);

	return {
		language: content.resolvedLanguage,
		attachmentStorageIds,
		sendRow: {
			kind: 'transactional' as const,
			transactionalEmailId: template._id,
			email: request.email,
			contactId: input.contactId,
			language: content.resolvedLanguage,
			dataVariables: request.dataVariables,
			status: 'queued',
			queuedAt: input.now,
			// Authoritative for the row even though the worker re-resolves its route.
			...(route ? { providerType: route.providerType } : {}),
			correlationId: input.correlationId,
			...(attachmentStorageIds && attachmentStorageIds.length > 0 ? { attachmentStorageIds } : {}),
		},
		// One write for the transactional + daily counters together, on the
		// `sends` counter row rather than the config singleton every feature gate
		// reads, so a send does not re-run gated queries.
		counterPatch: input.sendCounters
			? {
					transactionalSendCount: (input.sendCounters.transactionalSendCount ?? 0) + 1,
					...nextDailySendCount(input.sendCounters, 1, input.now),
				}
			: undefined,
		templatePatch: { sendCount: (template.sendCount ?? 0) + 1 },
		from,
		organizationId: input.organizationId,
		envelope: {
			kind: 'transactional' as const,
			emailPurpose: 'transactional' as const,
			to: request.email,
			from,
			...(route ? { providerType: route.providerType } : {}),
			...(route?.ipPool ? { ipPool: route.ipPool } : {}),
			template: {
				subject: content.subject,
				htmlContent: content.html,
				...(plainText ? { plainTextContent: plainText } : {}),
			},
			dataVariables: request.dataVariables,
			attachmentRefs: mergeAttachments(template.attachments, request.attachmentRefs),
			...(input.organizationId ? { organizationId: input.organizationId } : {}),
			// Unsubscribe footer — the worker builds the HMAC URLs from `siteUrl` +
			// `contactId` only when the template opts in.
			...(template.showUnsubscribe
				? { showUnsubscribe: true, contactId: input.contactId, siteUrl: input.siteUrl || undefined }
				: {}),
		},
	};
}
