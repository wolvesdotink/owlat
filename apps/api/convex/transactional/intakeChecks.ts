/**
 * The refusals of the transactional send intake, in the order a send meets
 * them: the feature flag, the shared intake gates (abuse, provider,
 * suppression), the template, the sender and its domain, the data variables
 * and the volume caps. They only read, so the intake mutation (`dispatch.ts`)
 * and the dry run (`dryRun.ts`, a query) ask the same function, and a dry run
 * reports exactly the refusal a send would meet.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { FeatureFlagState } from '@owlat/shared/featureFlags';
import { findContactByIdentifier } from '../contacts/resolution';
import { checkEmailDomainVerification } from '../domains/domains';
import { runSendIntakeGates } from '../delivery/sendIntakeGates';
import { featureDisabledMessage, resolveStoredFeatureFlags } from '../lib/featureFlags';
import { selectSendContent } from './dispatchContent';
import {
	decideSender,
	decideSenderAndVariables,
	decideTemplate,
	type DispatchRefusal,
	type ResolvedTransactionalSender,
	type TemplateLookup,
} from './dispatchDecision';
import { checkTransactionalSendCaps, type SendCapCharge } from './sendCaps';
import { transactionalSenderInputs } from './senderResolution';

type Ctx = QueryCtx | MutationCtx;

/**
 * The template a request names, by id or by slug. A malformed id, or one from
 * another table, reads as no template, the same as an unknown one.
 */
export async function loadRequestedTemplate(
	ctx: Ctx,
	lookup: TemplateLookup
): Promise<Doc<'transactionalEmails'> | null> {
	if (lookup.kind === 'slug') {
		return await ctx.db
			.query('transactionalEmails')
			.withIndex('by_slug', (q) => q.eq('slug', lookup.slug))
			.first();
	}
	const templateId = ctx.db.normalizeId('transactionalEmails', lookup.id);
	return templateId ? await ctx.db.get(templateId) : null;
}

/**
 * The language stored on the recipient's contact, read before the contact
 * upsert so a refused request writes nothing. The upsert never overwrites a
 * stored language, so the plan resolves the same one after it.
 */
export async function storedLanguage(ctx: Ctx, email: string): Promise<string | undefined> {
	return (await findContactByIdentifier(ctx, 'email', email))?.contact.language;
}

export interface IntakeRequest {
	templateLookup: TemplateLookup;
	email: string;
	dataVariables?: Record<string, unknown>;
	language?: string;
	apiKeyId?: Doc<'apiKeys'>['_id'];
}

export type IntakeCheck =
	| { ok: false; refusal: DispatchRefusal }
	| {
			ok: true;
			settings: Doc<'instanceSettings'> | null;
			template: Doc<'transactionalEmails'>;
			sender: ResolvedTransactionalSender;
			/** The caps an accepted send is charged against. */
			capCharges: SendCapCharge[];
	  };

/** Every refusal a send meets before anything is written, the first one that applies. */
export async function checkIntake(ctx: Ctx, request: IntakeRequest): Promise<IntakeCheck> {
	// The shared pre-row gates (abuse → provider-ready → suppression) run on
	// the settings row read once here, since the sender defaults and the caps
	// need it again. SUPPRESSION SCOPE `'transactional'`: a bounce or a
	// complaint blocks, a marketing-hygiene suppression does not, so receipts,
	// password resets and double-opt-in confirmations still reach someone who
	// ignores the newsletter.
	const settings = await ctx.db.query('instanceSettings').first();
	// The `transactional` feature floor, resolved from the row just read so
	// the singleton is not fetched twice.
	const flags = resolveStoredFeatureFlags((settings?.featureFlags ?? {}) as FeatureFlagState);
	if (!flags.transactional) {
		return refused({
			ok: false,
			reason: 'feature_disabled',
			detail: featureDisabledMessage('transactional'),
		});
	}
	const gates = await runSendIntakeGates(ctx, {
		email: request.email,
		suppressionScope: 'transactional',
		settings: settings ?? null,
		// The route resolution is address-aware and needs the sender settled
		// below, so the gate asks the route-INDEPENDENT question (can this
		// message type deliver at all) and the intake resolves the route later.
		providerReadiness: { kind: 'message_type', messageType: 'transactional' },
		noDeliveryProviderDetail:
			'No email delivery provider is configured. Set EMAIL_PROVIDER (+ credentials) or a provider route before sending transactional email.',
	});
	if (!gates.ok) return refused(gates);

	const found = decideTemplate(
		request.templateLookup,
		await loadRequestedTemplate(ctx, request.templateLookup)
	);
	if (!found.ok) return refused(found);
	const { template } = found;

	// The resolved sender's domain must be verified, then the variables must
	// match; then the volume caps (`./sendCaps.ts`).
	const sender = decideSender(transactionalSenderInputs(settings, template));
	if (!sender.ok) return refused(sender);
	const refusal = decideSenderAndVariables({
		fromEmail: sender.fromEmail,
		domainStatus: await checkEmailDomainVerification(ctx, sender.fromEmail),
		dataVariables: request.dataVariables,
		template,
		content: selectSendContent(
			template,
			request.language,
			await storedLanguage(ctx, request.email)
		),
	});
	if (refusal) return refused(refusal);
	const caps = await checkTransactionalSendCaps(ctx, template, request, settings);
	if (!caps.ok) return caps;

	return {
		ok: true,
		settings,
		template,
		sender: { fromEmail: sender.fromEmail, fromName: sender.fromName, source: sender.source },
		capCharges: caps.charges,
	};
}

function refused(refusal: DispatchRefusal): { ok: false; refusal: DispatchRefusal } {
	return { ok: false, refusal };
}
