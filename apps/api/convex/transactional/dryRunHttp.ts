/**
 * `POST /api/v1/transactional/dry-run`: what `POST /api/v1/transactional`
 * would do with the same body, without sending. It takes the send's body and
 * checks it the same way, spends one of the key's render tokens, asks the
 * dry-run query (`./dryRun.ts`) and shapes its outcome.
 *
 * Its own path, not a flag on the send: an instance that predates it answers
 * this path with a 404 and sends nothing, where an unknown body field would be
 * ignored and the email sent. The send route refuses a `dryRun` field for the
 * same reason (`./api.ts`).
 *
 * The answer is a `200`, never the `202` of a queued send, and its body says
 * `status: "dry_run"`. A refusal the send would meet is in `refusal`, as the
 * send's error body would carry it; a refusal that leaves nothing to compose
 * (an unknown template, the feature switched off, a list too long to write
 * out) is answered as the send answers it. No Idempotency-Key is read.
 */

import type { SendTransactionalDryRun } from '@owlat/public-contract';
import { decodeRequest, sendTransactionalRequestSchema } from '@owlat/public-contract/schemas';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import {
	createAuthenticatedHandler,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiHandlers';
import { errorResponse, invalidInputResponse, jsonResponse } from '../auth/apiResponses';
import { featureDisabledMessage } from '../lib/featureFlags';
import { normalizeEmail } from '../lib/inputGuards';
import { renderRateLimitedResponse } from '../publicApi/render';
import { TRANSACTIONAL_MAX_BODY_BYTES, validateDecodedBody } from './api';
import { prepareAttachments } from './attachmentIntake';
import { dispatchRefusalResponse, refusalAsSendWouldAnswer } from './refusalResponse';

export const dryRunTransactional = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'transactional:send', request.headers.get('Origin'));
		if (denied) return denied;
		// The send's feature floor, before the body is read or a render token
		// spent, so a dry run answers it as the send does.
		const flags = await ctx.runQuery(internal.workspaces.featureFlags.getResolvedFlags, {});
		if (!flags.transactional) {
			return errorResponse('forbidden', featureDisabledMessage('transactional'), {
				data: { reason: 'feature_disabled' },
			});
		}
		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return errorResponse('invalid_input', 'Invalid JSON in request body');
		}
		const decoded = decodeRequest(sendTransactionalRequestSchema, raw);
		if (!decoded.ok) return invalidInputResponse(decoded.message, decoded.field);
		const body = decoded.value;
		const bodyError = validateDecodedBody(body);
		if (bodyError) return bodyError;
		// Attachments are checked as a send checks them, and never stored.
		const attachments = prepareAttachments(body.attachments);
		if (!attachments.ok) return attachments.response;

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
	},
	{ maxBodyBytes: TRANSACTIONAL_MAX_BODY_BYTES }
);
