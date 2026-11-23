/**
 * The assistant's answer to "what happened to the mail for <address>": the
 * transactional sends to one address in the last 30 days, through the loader
 * `GET /api/v1/transactional` reads (`transactional/sendList.ts`), so the two
 * name the same sends.
 *
 * Every member reads a template's send log with its recipients in the web
 * app, so the answer tells a room nothing a member could not open. It leaves
 * out the address (the question named it), the data variables, and the ids;
 * the receiving server's reply is remote text and is scrubbed.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { SEND_LIST_MAX_WINDOW_DAYS } from '@owlat/public-contract';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { isValidEmail, normalizeEmail } from '../lib/inputGuards';
import { clampText, scrubForInjection } from './prompt';

const MAX_SENDS = 10;
const MAX_SERVER_REPLY = 300;
const WINDOW_MS = SEND_LIST_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export function buildGetTransactionalSends(ctx: ActionCtx): Tool {
	return tool({
		description: `Look up the transactional emails (password resets, receipts and the other mails the application sends through the API) sent to one email address in the last ${SEND_LIST_MAX_WINDOW_DAYS} days, newest first. Use it when someone asks whether, or why not, a mail to an address arrived. Each send has its template, status (queued, sent, delivered, opened, clicked, bounced, failed or complained) and when it reached each step. A failed send has \`errorCode\` and \`serverReply\` as the reason. A bounce has \`bounceType\` (hard: the receiving server refused it for good; soft: for now), \`bounceCause\` and \`serverReply\`, the receiving server's text, which says why. With \`bounceCause\` recipient the server refused the address: a hard bounce blocks it from further sends, and repeated soft bounces block it too. With sender the server refused our sending IP or domain, this bounce blocks no one, and getDeliveryHealth says what to fix. With null (an old bounce) the cause is not known. Whether the address is blocked now is not part of this answer.`,
		inputSchema: z.object({
			email: z.string().describe('The recipient address to look up.'),
		}),
		execute: async ({ email }) => {
			const address = normalizeEmail(email);
			if (!isValidEmail(address)) return { error: 'That is not an email address.' };
			const until = Date.now();
			const page = await ctx.runQuery(internal.transactional.sendList.listForApi, {
				email: address,
				status: null,
				since: until - WINDOW_MS,
				until,
				limit: MAX_SENDS,
				cursor: null,
			});
			return {
				sends: page.data.map((send) => ({
					template: send.slug,
					status: send.status,
					queuedAt: send.queuedAt,
					sentAt: send.sentAt,
					deliveredAt: send.deliveredAt,
					bouncedAt: send.bouncedAt,
					failedAt: send.failedAt,
					bounceType: send.bounceType,
					bounceCause: send.bounceCause,
					errorCode: send.errorCode,
					serverReply:
						send.errorMessage === null
							? null
							: scrubForInjection(clampText(send.errorMessage, MAX_SERVER_REPLY)),
				})),
				isComplete: page.isDone,
			};
		},
	});
}
