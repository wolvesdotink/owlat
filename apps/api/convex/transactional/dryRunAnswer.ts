/**
 * The answer of `POST /api/v1/transactional` with `dryRun: true`. The send
 * route (`./api.ts`) hands over a decoded, checked body; this spends one of
 * the key's render tokens, asks the dry-run query (`./dryRun.ts`) and shapes
 * its outcome.
 *
 * The answer is a `200`, never the `202` of a queued send, and its body says
 * `status: "dry_run"`. A refusal the send would meet is in `refusal`, as the
 * send's error body would carry it; a refusal that leaves nothing to compose
 * (an unknown template, the feature switched off, a list too long to write
 * out) is answered as the send answers it.
 */

import type { SendTransactionalDryRun } from '@owlat/public-contract';
import {
	apiErrorResponseSchema,
	type sendTransactionalRequestSchema,
} from '@owlat/public-contract/schemas';
import type { z } from 'zod';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { AuthenticatedContext } from '../auth/apiHandlers';
import { jsonResponse } from '../auth/apiResponses';
import { normalizeEmail } from '../lib/inputGuards';
import { renderRateLimitedResponse } from '../publicApi/render';
import type { DispatchRefusal } from './dispatchDecision';
import { dispatchRefusalResponse } from './refusalResponse';

type SendTransactionalBody = z.output<typeof sendTransactionalRequestSchema>;

/** A refusal as the send's error body carries it, with the status it would answer. */
export async function refusalAsSendWouldAnswer(
	ctx: ActionCtx,
	refusal: DispatchRefusal
): Promise<NonNullable<SendTransactionalDryRun['refusal']>> {
	const response = await dispatchRefusalResponse(ctx, refusal);
	// The body this server just built; the shared schema reads it as a check.
	const body = apiErrorResponseSchema.parse(await response.json());
	const retryAfter = response.headers.get('Retry-After');
	return {
		status: response.status,
		category: body.error.category,
		message: body.error.message,
		data: body.error.data ?? {},
		retryAfter: retryAfter === null ? null : Number(retryAfter),
	};
}

export async function answerDryRun(
	ctx: ActionCtx,
	auth: AuthenticatedContext,
	body: SendTransactionalBody
): Promise<Response> {
	const token = await ctx.runMutation(internal.publicApi.render.spendRenderToken, {
		keyId: auth.keyId,
	});
	if (!token.ok) return renderRateLimitedResponse(token.retryAfterSeconds, auth.rateLimit);

	const email = normalizeEmail(body.email);
	const outcome = await ctx.runQuery(internal.transactional.dryRun.dryRunForApi, {
		templateLookup: body.transactionalId
			? { kind: 'id', id: body.transactionalId }
			: // The schema refuses a body naming neither.
				{ kind: 'slug', slug: body.slug! },
		email,
		...(body.dataVariables === undefined ? {} : { dataVariables: body.dataVariables }),
		...(body.language === undefined ? {} : { language: body.language }),
		apiKeyId: auth.keyId,
		canReadUnpublished: auth.scopes.includes('templates:read'),
	});
	if (!outcome.ok) return await dispatchRefusalResponse(ctx, outcome.refusal);

	const data: SendTransactionalDryRun = {
		status: 'dry_run',
		dryRun: true,
		wouldQueue: outcome.refusal === null,
		refusal: outcome.refusal ? await refusalAsSendWouldAnswer(ctx, outcome.refusal) : null,
		email: body.email,
		templateId: outcome.template.id,
		slug: outcome.template.slug,
		templateStatus: outcome.template.status,
		contactId: outcome.contactId,
		language: outcome.language,
		subject: outcome.subject,
		html: outcome.html,
		text: outcome.text,
		unsubscribeFooter: outcome.unsubscribeFooter,
		missingVariables: outcome.missingVariables,
	};
	return jsonResponse({ data }, 200);
}
