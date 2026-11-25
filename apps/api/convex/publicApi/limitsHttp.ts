/**
 * GET /api/v1/limits — the transactional send limits that apply to the asking
 * key, and what is left of its daily one (`transactional/sendLimits.ts`).
 *
 * Any key may read its own: the caps are the instance's, the count is the
 * key's own, and neither names a recipient. The read charges no limit beyond
 * the request itself.
 *
 * With `email` and a template (`slug` or `transactionalId`, as the send body
 * names one) it also reads that pair's per-recipient count. That count is
 * shared by every key sending the template to the address, so it needs the
 * scope and feature floor of the send list, which already shows every key's
 * sends to an address: a key learns nothing about an address it could not
 * list.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { createAuthenticatedHandler, type AuthenticatedContext } from '../auth/apiHandlers';
import { errorResponse, invalidInputResponse, jsonResponse } from '../auth/apiResponses';
import { isValidEmail, normalizeEmail } from '../lib/inputGuards';
import { refuseRead } from '../transactional/sendStatusHttp';

interface RecipientQuery {
	email: string;
	transactionalId: string | null;
	slug: string | null;
}

/**
 * The pair the query names, null when it names none, or the refusal. An empty
 * `email` is refused like the send list's; an empty template selector counts
 * as absent, as in the send body.
 */
function readRecipientQuery(
	params: URLSearchParams
): { ok: true; value: RecipientQuery | null } | { ok: false; message: string; field: string } {
	const rawEmail = params.get('email');
	const transactionalId = params.get('transactionalId') || null;
	const slug = params.get('slug') || null;
	const hasTemplate = transactionalId !== null || slug !== null;
	if (rawEmail === null) {
		if (!hasTemplate) return { ok: true, value: null };
		return { ok: false, message: 'email is required with a template', field: 'email' };
	}
	const email = normalizeEmail(rawEmail);
	if (!isValidEmail(email)) return { ok: false, message: 'Invalid email format', field: 'email' };
	if (!hasTemplate) {
		return { ok: false, message: 'slug or transactionalId is required with email', field: 'slug' };
	}
	return { ok: true, value: { email, transactionalId, slug } };
}

export const getLimits = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const recipient = readRecipientQuery(new URL(request.url).searchParams);
		if (!recipient.ok) return invalidInputResponse(recipient.message, recipient.field);
		const now = Date.now();
		let usage = null;
		if (recipient.value !== null) {
			const refused = await refuseRead(ctx, request, auth);
			if (refused) return refused;
			usage = await ctx.runQuery(internal.transactional.sendLimits.recipientUsage, {
				...recipient.value,
				now,
			});
			if (usage === null) {
				const { transactionalId, slug } = recipient.value;
				return errorResponse(
					'not_found',
					transactionalId !== null
						? `Transactional email with ID "${transactionalId}" not found`
						: `Transactional email with slug "${slug}" not found`,
					{
						data: {
							reason: 'template_not_found',
							field: transactionalId !== null ? 'transactionalId' : 'slug',
						},
					}
				);
			}
		}
		const limits = await ctx.runQuery(internal.transactional.sendLimits.forApiKey, {
			keyId: auth.keyId,
			now,
		});
		if (usage === null) return jsonResponse({ data: limits });
		return jsonResponse({
			data: { ...limits, recipientSends: { ...limits.recipientSends, usage } },
		});
	}
);
