/**
 * `/api/v1/transactional-emails`: list, read, create, replace (an upsert by
 * slug), publish and unpublish transactional emails with an API key.
 *
 * Reads need `templates:read`, writes and publishing `templates:write`; the
 * send scope grants neither. A route decodes the body, runs the content check
 * (`templateContent.ts`) and hands the write to one mutation in
 * `transactionalEmails.ts`, which writes through the editor's own path.
 *
 * A `GET` answers the email's content revision as an `ETag`; a write or
 * publish that sends it back as `If-Match` is refused when the email moved on
 * in the meantime, so a script never overwrites an edit made in the editor
 * after it read the email.
 */

import { isValidSlug } from '@owlat/shared';
import type {
	TransactionalEmail,
	TransactionalEmailInput,
	TransactionalEmailWriteResult,
} from '@owlat/public-contract';
import {
	createTransactionalEmailRequestSchema,
	decodeRequest,
	putTransactionalEmailRequestSchema,
	readListQuery,
} from '@owlat/public-contract/schemas';
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
	pathSegmentAfter,
	type RateLimitHeaders,
} from '../auth/apiResponses';
import { checkContent, estimatedStoredBytes, MAX_STORED_EMAIL_BYTES } from './templateContent';

/**
 * Body ceiling of a template write. Block content is larger than any other
 * request body, but a stored email has to fit one Convex document together
 * with its rendered HTML, so the content check refuses most of a body this
 * size before the write does.
 */
export const MAX_TEMPLATE_BODY_BYTES = 1_000_000;

const PATH_MARKER = 'transactional-emails';

/** The `{slug}` of the path, or the 400 / 404 to answer. */
function slugFromPath(request: Request, trailing: readonly string[] = []): string | Response {
	const segment = pathSegmentAfter(request, PATH_MARKER);
	if (!segment.ok) {
		return invalidInputResponse(
			segment.reason === 'missing' ? 'The slug is required' : 'Invalid slug in the path',
			'slug'
		);
	}
	const parts = new URL(request.url).pathname.split('/');
	const rest = parts.slice(parts.indexOf(PATH_MARKER) + 2).filter(Boolean);
	if (rest.length !== trailing.length || rest.some((part, i) => part !== trailing[i])) {
		return errorResponse('not_found', 'Not found');
	}
	return segment.value;
}

/** The revision an `If-Match` header names, `undefined` without one, or the 400. */
function ifMatchRevision(request: Request): number | undefined | Response {
	const header = request.headers.get('If-Match');
	if (header === null || header.trim() === '') return undefined;
	const match = /^\s*(?:W\/)?"?(\d{1,15})"?\s*$/.exec(header);
	if (!match) {
		return invalidInputResponse(
			'If-Match must be the revision a read answered with, such as "3"',
			'If-Match'
		);
	}
	return Number(match[1]);
}

const etag = (email: TransactionalEmail) => ({ ETag: `"${email.revision}"` });

function rateLimitedResponse(retryAfterSeconds: number, rateLimit: RateLimitHeaders): Response {
	return errorResponse(
		'rate_limited',
		'Too many template writes from this API key. Retry after the Retry-After header.',
		{
			data: { reason: 'template_write_rate_limited' },
			retryAfter: retryAfterSeconds,
			rateLimit,
		}
	);
}

/** The editable fields of a decoded body, checked and ready for the write mutation. */
type PreparedWrite =
	| {
			ok: true;
			fields: {
				name: string;
				subject: string;
				content: string;
				translations: string;
				defaultLanguage: string;
				dataVariablesSchema: Record<string, 'string' | 'number' | 'boolean' | 'date' | 'array'>;
				showUnsubscribe: boolean;
			};
			issues: TransactionalEmailWriteResult['issues'];
	  }
	| { ok: false; response: Response };

/** The content of a decoded body, checked and serialised as the row stores it. */
export type PreparedContent =
	| {
			ok: true;
			defaultLanguage: string;
			/** The sanitised blocks the content check returned, as stored JSON. */
			content: string;
			/** The translation overlays as stored JSON. */
			translations: string;
			issues: TransactionalEmailWriteResult['issues'];
	  }
	| { ok: false; response: Response };

/**
 * Check the blocks and translations of a body the way the editor would before
 * saving them, and serialise them as the row stores them. Refuses a block the
 * content check finds an error in, naming the block, and content too large to
 * store. A write and the render (`renderHttp.ts`) both start here.
 */
export function prepareContent(
	body: Pick<TransactionalEmailInput, 'blocks' | 'translations' | 'defaultLanguage'>
): PreparedContent {
	const defaultLanguage = body.defaultLanguage ?? 'en';
	const translations = body.translations ?? {};
	if (Object.prototype.hasOwnProperty.call(translations, defaultLanguage)) {
		return {
			ok: false,
			response: invalidInputResponse(
				'A translation cannot be in the default language; the default-language content is subject and blocks',
				`translations.${defaultLanguage}`
			),
		};
	}

	const check = checkContent(body.blocks);
	if (check.firstError) {
		return {
			ok: false,
			response: errorResponse(
				'invalid_input',
				check.firstError.blockId
					? `Block ${check.firstError.blockId}: ${check.firstError.message}`
					: check.firstError.message,
				{
					data: {
						reason: 'invalid_content',
						field: 'blocks',
						...(check.firstError.blockId ? { blockId: check.firstError.blockId } : {}),
						issues: check.issues,
					},
				}
			),
		};
	}

	const stored: Record<string, { subject?: string; blocks: Record<string, unknown> }> = {};
	for (const [language, overlay] of Object.entries(translations)) {
		stored[language] = {
			...(typeof overlay.subject === 'string' ? { subject: overlay.subject } : {}),
			blocks: overlay.blocks ?? {},
		};
	}
	const translationsJson = JSON.stringify(stored);
	const languageCount = 1 + Object.keys(stored).length;
	if (estimatedStoredBytes(check, translationsJson, languageCount) > MAX_STORED_EMAIL_BYTES) {
		return {
			ok: false,
			response: errorResponse(
				'invalid_input',
				`The email is too large to store: its blocks, translations and the HTML rendered for each of its ${languageCount} languages must stay under about ${Math.floor(MAX_STORED_EMAIL_BYTES / 1000)} KB.`,
				{ data: { reason: 'content_too_large', field: 'blocks' } }
			),
		};
	}

	return {
		ok: true,
		defaultLanguage,
		content: JSON.stringify(check.blocks),
		translations: translationsJson,
		issues: check.issues,
	};
}

/**
 * Check a decoded body the way the editor would before saving it, and
 * serialise it as the row stores it.
 */
function prepareWrite(body: TransactionalEmailInput): PreparedWrite {
	const content = prepareContent(body);
	if (!content.ok) return content;
	return {
		ok: true,
		fields: {
			name: body.name.trim(),
			subject: body.subject ?? '',
			content: content.content,
			translations: content.translations,
			defaultLanguage: content.defaultLanguage,
			dataVariablesSchema: { ...body.dataVariablesSchema },
			showUnsubscribe: body.showUnsubscribe ?? false,
		},
		issues: content.issues,
	};
}

export async function readJson(request: Request): Promise<unknown | Response> {
	try {
		return await request.json();
	} catch {
		return errorResponse('invalid_input', 'Invalid JSON in request body');
	}
}

/**
 * GET /api/v1/transactional-emails - List transactional emails, oldest first.
 */
export const listTransactionalEmails = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'templates:read', request.headers.get('Origin'));
		if (denied) return denied;
		const query = readListQuery(new URL(request.url).searchParams);
		if (!query.ok) return invalidInputResponse(query.message, query.field);
		if (query.value.search !== undefined) {
			return invalidInputResponse('Transactional emails cannot be searched', 'search');
		}
		try {
			const page = await ctx.runQuery(internal.publicApi.transactionalEmails.listForApi, {
				limit: query.value.limit,
				cursor: query.value.cursor,
			});
			return jsonResponse(page);
		} catch (error) {
			return errorResponseFromThrow(error, 'Failed to list transactional emails');
		}
	}
);

/**
 * POST /api/v1/transactional-emails - Create a transactional email as a draft.
 */
export const createTransactionalEmail = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'templates:write', request.headers.get('Origin'));
		if (denied) return denied;
		const raw = await readJson(request);
		if (raw instanceof Response) return raw;
		const decoded = decodeRequest(createTransactionalEmailRequestSchema, raw);
		if (!decoded.ok) return invalidInputResponse(decoded.message, decoded.field);
		if (!isValidSlug(decoded.value.slug)) {
			return invalidInputResponse(
				'slug must hold only lowercase letters, digits and hyphens',
				'slug'
			);
		}
		const prepared = prepareWrite(decoded.value);
		if (!prepared.ok) return prepared.response;
		try {
			const outcome = await ctx.runMutation(internal.publicApi.transactionalEmails.createForApi, {
				keyId: auth.keyId,
				slug: decoded.value.slug,
				fields: prepared.fields,
			});
			if (!outcome.ok) return rateLimitedResponse(outcome.retryAfterSeconds, auth.rateLimit);
			const data: TransactionalEmailWriteResult = {
				email: outcome.email,
				issues: prepared.issues,
			};
			return jsonResponse({ data }, 201, etag(outcome.email));
		} catch (error) {
			return errorResponseFromThrow(error, 'Failed to create the transactional email');
		}
	},
	{ maxBodyBytes: MAX_TEMPLATE_BODY_BYTES }
);

/**
 * GET /api/v1/transactional-emails/{slug} - One transactional email with its content.
 */
export const getTransactionalEmail = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'templates:read', request.headers.get('Origin'));
		if (denied) return denied;
		const slug = slugFromPath(request);
		if (slug instanceof Response) return slug;
		try {
			const email = await ctx.runQuery(internal.publicApi.transactionalEmails.getForApi, { slug });
			if (!email) return errorResponse('not_found', 'Transactional email not found');
			return jsonResponse({ data: email }, 200, etag(email));
		} catch (error) {
			return errorResponseFromThrow(error, 'Failed to read the transactional email');
		}
	}
);

/**
 * PUT /api/v1/transactional-emails/{slug} - Create the email with this slug,
 * or replace its editable fields.
 */
export const putTransactionalEmail = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'templates:write', request.headers.get('Origin'));
		if (denied) return denied;
		const slug = slugFromPath(request);
		if (slug instanceof Response) return slug;
		if (!isValidSlug(slug)) {
			return invalidInputResponse(
				'slug must hold only lowercase letters, digits and hyphens',
				'slug'
			);
		}
		const expectedRevision = ifMatchRevision(request);
		if (expectedRevision instanceof Response) return expectedRevision;
		const whilePublished = new URL(request.url).searchParams.get('whilePublished');
		if (whilePublished !== null && whilePublished !== 'true' && whilePublished !== 'false') {
			return invalidInputResponse('whilePublished must be true or false', 'whilePublished');
		}

		const raw = await readJson(request);
		if (raw instanceof Response) return raw;
		const decoded = decodeRequest(putTransactionalEmailRequestSchema, raw);
		if (!decoded.ok) return invalidInputResponse(decoded.message, decoded.field);
		if (decoded.value.slug !== undefined && decoded.value.slug !== slug) {
			return invalidInputResponse(
				'The slug in the body differs from the slug in the path; a PUT cannot rename an email',
				'slug'
			);
		}
		const prepared = prepareWrite(decoded.value);
		if (!prepared.ok) return prepared.response;
		try {
			const outcome = await ctx.runMutation(internal.publicApi.transactionalEmails.putForApi, {
				keyId: auth.keyId,
				slug,
				fields: prepared.fields,
				...(expectedRevision === undefined ? {} : { expectedRevision }),
				whilePublished: whilePublished === 'true',
			});
			if (!outcome.ok) return rateLimitedResponse(outcome.retryAfterSeconds, auth.rateLimit);
			const data: TransactionalEmailWriteResult = {
				email: outcome.email,
				issues: prepared.issues,
			};
			return jsonResponse({ data }, 200, etag(outcome.email));
		} catch (error) {
			return errorResponseFromThrow(error, 'Failed to write the transactional email');
		}
	},
	{ maxBodyBytes: MAX_TEMPLATE_BODY_BYTES }
);

/**
 * POST /api/v1/transactional-emails/{slug}/publish and /unpublish.
 */
export const transitionTransactionalEmail = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'templates:write', request.headers.get('Origin'));
		if (denied) return denied;
		const segments = new URL(request.url).pathname.split('/').filter(Boolean);
		const action = segments[segments.length - 1];
		if (action !== 'publish' && action !== 'unpublish') {
			return errorResponse('not_found', 'Not found');
		}
		const slug = slugFromPath(request, [action]);
		if (slug instanceof Response) return slug;
		try {
			if (action === 'publish') {
				const expectedRevision = ifMatchRevision(request);
				if (expectedRevision instanceof Response) return expectedRevision;
				const outcome = await ctx.runMutation(
					internal.publicApi.transactionalEmails.publishForApi,
					{
						keyId: auth.keyId,
						slug,
						...(expectedRevision === undefined ? {} : { expectedRevision }),
					}
				);
				if (!outcome.ok) return rateLimitedResponse(outcome.retryAfterSeconds, auth.rateLimit);
				return jsonResponse({ data: outcome.email }, 200, etag(outcome.email));
			}
			const outcome = await ctx.runMutation(
				internal.publicApi.transactionalEmails.unpublishForApi,
				{ keyId: auth.keyId, slug }
			);
			if (!outcome.ok) return rateLimitedResponse(outcome.retryAfterSeconds, auth.rateLimit);
			return jsonResponse({ data: outcome.email });
		} catch (error) {
			return errorResponseFromThrow(error, `Failed to ${action} the transactional email`);
		}
	}
);
