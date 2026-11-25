/**
 * `POST /api/v1/render`: render block content as this instance would store
 * it, and with sample data as a send would compose it, without storing
 * anything.
 *
 * Every step is the one a write or a send takes, called from here instead of
 * copied: the content check and serialisation of a template write
 * (`prepareContent`), the normalisation an edit applies before it renders
 * (`storedContentFields`), the server render of a save (`renderForWrite`, with
 * the instance's theme), the language pick of a send (`selectSendContent`),
 * its variable checks (`decideVariables`) and the worker's composition
 * (`composeForSend`). So the answer is what a save would store and a send
 * would deliver.
 *
 * `templates:read` is enough: the route writes no row, records no scan verdict
 * and spends no send cap. It spends one token of the key's render bucket
 * (`render.ts`), shared with the send's dry run.
 */

import { analyzeEmail, forceColorScheme, getEmailHealthScore } from '@owlat/email-renderer';
import type { EditorBlock } from '@owlat/shared';
import type { EmailHealth, RenderResult } from '@owlat/public-contract';
import { decodeRequest, renderRequestSchema } from '@owlat/public-contract/schemas';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import {
	createAuthenticatedHandler,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiHandlers';
import {
	errorResponse,
	errorResponseFromThrow,
	invalidInputResponse,
	jsonResponse,
} from '../auth/apiResponses';
import { composeForSend } from '../delivery/sendComposition';
import { parseContentBlocks } from '../emailBlocks/consumers';
import { featureDisabledMessage } from '../lib/featureFlags';
import { storedContentFields } from '../lib/publishableEmail';
import { renderForWrite } from '../lib/publishableEmailRender';
import { missingDataVariables, selectSendContent } from '../transactional/dispatchContent';
import { decideVariables, oversizedVariablesRefusal } from '../transactional/dispatchDecision';
import {
	dispatchRefusalResponse,
	refusalAsSendWouldAnswer,
} from '../transactional/refusalResponse';
import { renderRateLimitedResponse } from './render';
import { MAX_TEMPLATE_BODY_BYTES, prepareContent, readJson } from './transactionalEmailsHttp';

/** The scores of `getEmailHealthScore` with the analysis they read, in the contract's shape. */
function healthOf(blocks: readonly EditorBlock[], html: string): EmailHealth {
	const analysis = analyzeEmail(html);
	const score = getEmailHealthScore([...blocks], html, undefined, { analysis });
	return {
		overall: score.overall,
		compatibility: score.compatibility,
		accessibility: score.accessibility,
		deliverability: score.deliverability,
		outlookSupport: score.outlookSupport,
		recommendations: score.recommendations,
		analysis: {
			htmlSizeBytes: analysis.htmlSizeBytes,
			exceedsGmailClip: analysis.exceedsGmailClip,
			exceedsGmailCssLimit: analysis.exceedsGmailCssLimit === true,
			styleBlockSizeBytes: analysis.styleBlockSizeBytes ?? 0,
			tableNestingDepth: analysis.tableNestingDepth,
			imageCount: analysis.imageCount,
			linkCount: analysis.linkCount,
			hasTextContent: analysis.hasTextContent,
			// Text without an image is an infinite ratio, which JSON cannot carry.
			textToImageRatio: Number.isFinite(analysis.textToImageRatio)
				? analysis.textToImageRatio
				: null,
			displayNoneCount: analysis.displayNoneCount,
			warnings: analysis.warnings,
		},
	};
}

export const renderEmail = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'templates:read', request.headers.get('Origin'));
		if (denied) return denied;
		const raw = await readJson(request);
		if (raw instanceof Response) return raw;
		const decoded = decodeRequest(renderRequestSchema, raw);
		if (!decoded.ok) return invalidInputResponse(decoded.message, decoded.field);
		const body = decoded.value;
		const kind = body.kind ?? 'transactional';
		if (kind === 'template' && body.dataVariables !== undefined) {
			return invalidInputResponse(
				'dataVariables belong to a transactional email; a template is personalised per contact when a campaign sends it',
				'dataVariables'
			);
		}

		const token = await ctx.runMutation(internal.publicApi.render.spendRenderToken, {
			keyId: auth.keyId,
		});
		if (!token.ok) return renderRateLimitedResponse(token.retryAfterSeconds, auth.rateLimit);
		const settings = await ctx.runQuery(internal.publicApi.render.renderSettings, {});
		if (kind === 'transactional' && !settings.transactionalEnabled) {
			return errorResponse('forbidden', featureDisabledMessage('transactional'), {
				data: { reason: 'feature_disabled', feature: 'transactional' },
			});
		}

		const prepared = prepareContent(body);
		if (!prepared.ok) return prepared.response;
		const languages = [prepared.defaultLanguage, ...Object.keys(body.translations ?? {})];
		const stored = storedContentFields({
			subject: body.subject ?? '',
			...(body.previewText === undefined ? {} : { previewText: body.previewText }),
			content: prepared.content,
			translations: prepared.translations,
		});
		const row = {
			content: stored.content!,
			subject: stored.subject!,
			previewText: stored.previewText,
			translations: stored.translations,
			supportedLanguages: languages,
			defaultLanguage: prepared.defaultLanguage,
		};

		let rendered: ReturnType<typeof renderForWrite>;
		try {
			rendered = renderForWrite(
				row,
				kind === 'transactional' ? 'data' : 'personalization',
				settings.theme ?? undefined
			);
		} catch (error) {
			return errorResponseFromThrow(error, 'Failed to render the email');
		}

		// The language pick and fallback of a send, over what a save stores.
		const content = selectSendContent(
			{
				defaultLanguage: row.defaultLanguage,
				supportedLanguages: languages,
				htmlContent: rendered.html,
				subject: row.subject,
				htmlTranslations: rendered.htmlTranslations,
				plainTextContent: rendered.plainTextContent,
			},
			body.language,
			undefined
		);

		const sample = kind === 'transactional' ? body.dataVariables : undefined;
		let answer: Pick<RenderResult, 'subject' | 'html' | 'text' | 'sendRefusal'>;
		if (sample === undefined) {
			answer = {
				subject: content.subject,
				html: content.html,
				text: content.plainText ?? null,
				sendRefusal: null,
			};
		} else {
			// A list that writes out an oversized email is refused before it is
			// composed, with the send's own 400.
			const oversized = oversizedVariablesRefusal(content, sample);
			if (oversized) return await dispatchRefusalResponse(ctx, oversized);
			const refusal = decideVariables({
				dataVariables: sample,
				template: { dataVariablesSchema: body.dataVariablesSchema },
				content,
			});
			const composed = composeForSend({
				kind: 'transactional',
				template: {
					subject: content.subject,
					htmlContent: content.html,
					...(content.plainText ? { plainTextContent: content.plainText } : {}),
				},
				dataVariables: sample,
			});
			answer = {
				subject: composed.subject,
				html: composed.html,
				text: composed.text,
				sendRefusal: refusal ? await refusalAsSendWouldAnswer(ctx, refusal) : null,
			};
		}

		const data: RenderResult = {
			kind,
			language: content.language,
			composed: sample !== undefined,
			...answer,
			darkHtml: body.darkMode === true ? forceColorScheme(answer.html, 'dark') : null,
			issues: prepared.issues,
			missingVariables: kind === 'transactional' ? missingDataVariables(content, sample ?? {}) : [],
			health: healthOf(parseContentBlocks(row.content) as unknown as EditorBlock[], answer.html),
		};
		return jsonResponse({ data }, 200);
	},
	{ maxBodyBytes: MAX_TEMPLATE_BODY_BYTES }
);
