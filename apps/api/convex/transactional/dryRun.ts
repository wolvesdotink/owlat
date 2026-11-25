/**
 * The dry run of `POST /api/v1/transactional`: the email a send would compose
 * for this template, recipient, language and data, and the refusal the send
 * would meet, without sending.
 *
 * It is a query, so it cannot write: no contact is created, no Send is
 * queued, no cap or Idempotency-Key is spent and no webhook fires. The checks
 * are the intake's own (`./intakeChecks.ts`) and the composition is the
 * worker's (`delivery/sendComposition`), so the answer is what the send would
 * have done at this moment.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
import { findContactByIdentifier } from '../contacts/resolution';
import { composeForSend } from '../delivery/sendComposition';
import { dataVariablesRecord } from '../lib/convexValidators';
import { missingDataVariables, selectSendContent } from './dispatchContent';
import {
	decideTemplate,
	oversizedVariablesRefusal,
	type DispatchRefusal,
} from './dispatchDecision';
import { checkIntake, loadRequestedTemplate } from './intakeChecks';

export type DryRunOutcome =
	/** Nothing to compose: the send's own refusal is the answer. */
	| { ok: false; refusal: DispatchRefusal }
	| {
			ok: true;
			/** The refusal a send would meet now, or `null` when it would be queued. */
			refusal: DispatchRefusal | null;
			template: {
				id: Id<'transactionalEmails'>;
				slug: string;
				status: Doc<'transactionalEmails'>['status'];
			};
			language: string;
			subject: string;
			html: string;
			text: string;
			/** The recipient's contact, or `null` when a send would create it. */
			contactId: Id<'contacts'> | null;
			/** Delivery appends the unsubscribe footer, which a dry run leaves out. */
			unsubscribeFooter: boolean;
			/** Variables the content uses without a fallback that the data leaves out. */
			missingVariables: string[];
	  };

export const dryRunForApi = internalQuery({
	args: {
		templateLookup: v.union(
			v.object({ kind: v.literal('id'), id: v.string() }),
			v.object({ kind: v.literal('slug'), slug: v.string() })
		),
		email: v.string(),
		dataVariables: v.optional(dataVariablesRecord),
		language: v.optional(v.string()),
		apiKeyId: v.id('apiKeys'),
		/**
		 * Whether the key may read an email that is not published. Without it a
		 * dry run of a draft answers the send's `template_not_published`, so a
		 * send-only key learns no more than a send would tell it.
		 */
		canReadUnpublished: v.boolean(),
	},
	handler: async (ctx, args): Promise<DryRunOutcome> => {
		const check = await checkIntake(ctx, args);
		const refusal = check.ok ? null : check.refusal;
		if (refusal?.reason === 'feature_disabled') return { ok: false, refusal };

		const template = check.ok
			? check.template
			: await loadRequestedTemplate(ctx, args.templateLookup);
		// `checkIntake` refused at the latest at the template lookup, so a
		// missing template always comes with a refusal.
		if (!template) return { ok: false, refusal: refusal! };
		if (template.status !== 'published' && !args.canReadUnpublished) {
			return { ok: false, refusal: refusal! };
		}
		if (!template.htmlContent) {
			const noContent = decideTemplate(args.templateLookup, { ...template, status: 'published' });
			return { ok: false, refusal: noContent.ok ? refusal! : noContent };
		}

		const contact = await findContactByIdentifier(ctx, 'email', args.email);
		const content = selectSendContent(template, args.language, contact?.contact.language);
		const oversized = oversizedVariablesRefusal(content, args.dataVariables);
		if (oversized) return { ok: false, refusal: oversized };

		// The envelope a send hands the worker carries exactly this template
		// part (`planTransactionalSend`), and the worker composes it so.
		const composed = composeForSend({
			kind: 'transactional',
			template: {
				subject: content.subject,
				htmlContent: content.html,
				...(content.plainText ? { plainTextContent: content.plainText } : {}),
			},
			dataVariables: args.dataVariables,
		});

		return {
			ok: true,
			refusal,
			template: { id: template._id, slug: template.slug, status: template.status },
			language: content.language,
			subject: composed.subject,
			html: composed.html,
			text: composed.text,
			contactId: contact?.contact._id ?? null,
			unsubscribeFooter: template.showUnsubscribe === true,
			missingVariables: missingDataVariables(
				content,
				args.dataVariables,
				template.optionalDataVariables
			),
		};
	},
});
