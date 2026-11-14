// ============================================================
// Transactional dispatch — pure content/variable helpers
// ============================================================
//
// Extracted from `dispatch.ts` (which stays under the file-size ratchet): these
// are the side-effect-free helpers the dispatch mutation composes — data-variable
// validation, language resolution, translated-content selection, and attachment
// merging. Kept in their own module so they can be unit-tested in isolation.
// `dispatch.ts` re-exports them, so existing import paths stay stable.

import { v } from 'convex/values';
import { decodeJsonText } from '@owlat/worker-protocol/decodeJson';
import { pickHtmlTranslation } from '../lib/emailJson';
import { variablesWithoutFallback } from '../delivery/sendComposition/personalization';

/** A template-side attachment as the template's `attachments` JSON stores it. */
const templateAttachmentsValidator = v.array(
	v.object({ filename: v.string(), contentType: v.optional(v.string()), url: v.string() })
);

export type AttachmentRef = {
	filename: string;
	contentType?: string;
	url: string;
	storageId?: string;
};

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
	schema: Record<string, string> | undefined
): { valid: boolean; error?: string } {
	if (!schema) return { valid: true };
	if (!variables) return { valid: true };

	for (const [key, expectedType] of Object.entries(schema)) {
		const value = variables[key];
		if (value == null) continue;

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
	availableLanguages: string[]
): string {
	const fallback = templateDefaultLanguage ?? 'en';
	const candidate = requestLanguage ?? contactLanguage ?? fallback;
	if (candidate === fallback) return fallback;
	return availableLanguages.includes(candidate) ? candidate : fallback;
}

/**
 * Pick `htmlContent` + `subject` for the resolved language from the
 * template's `htmlTranslations` JSON (or fall back to the default
 * top-level fields). A blob or entry that does not decode is treated as no
 * translation for the language.
 */
export function selectContent(
	language: string,
	templateDefaultLanguage: string,
	defaultHtmlContent: string,
	defaultSubject: string,
	htmlTranslationsJson: string | undefined
): { html: string; subject: string; resolvedLanguage: string } {
	if (language === templateDefaultLanguage || !htmlTranslationsJson) {
		return {
			html: defaultHtmlContent,
			subject: defaultSubject,
			resolvedLanguage: templateDefaultLanguage,
		};
	}

	const picked = pickHtmlTranslation(htmlTranslationsJson, language);
	if (picked.ok && picked.value) {
		return {
			html: picked.value.htmlContent,
			subject: picked.value.subject,
			resolvedLanguage: language,
		};
	}

	return {
		html: defaultHtmlContent,
		subject: defaultSubject,
		resolvedLanguage: templateDefaultLanguage,
	};
}

/** What one send renders: the language it went out in and that language's content. */
export interface SendContent {
	language: string;
	subject: string;
	html: string;
	plainText: string | undefined;
}

/**
 * The content a send to a recipient renders, after the language fallback
 * chain ({@link resolveLanguage}) and the translation fallback
 * ({@link selectContent}). The pre-generated text/plain body belongs to the
 * default language only: translations carry no translated text body, and
 * pairing the default language's text with translated html would send two
 * languages in one message.
 */
export function selectSendContent(
	template: {
		defaultLanguage?: string;
		supportedLanguages?: string[];
		htmlContent?: string;
		subject: string;
		htmlTranslations?: string;
		plainTextContent?: string;
	},
	requestLanguage: string | undefined,
	contactLanguage: string | undefined
): SendContent {
	const defaultLanguage = template.defaultLanguage ?? 'en';
	const language = resolveLanguage(
		requestLanguage,
		contactLanguage,
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
	return {
		language: content.resolvedLanguage,
		subject: content.subject,
		html: content.html,
		plainText: content.resolvedLanguage === defaultLanguage ? template.plainTextContent : undefined,
	};
}

/**
 * The variables the content uses without a fallback that the request leaves
 * out or sends as `null`: each would render as an empty string. The template's
 * `dataVariablesSchema` records only a type per variable, not whether one is
 * required, so the content is what decides: a variable with a fallback
 * (`{{name|'there'}}`) or one the content never uses is never required.
 */
export function missingDataVariables(
	content: Pick<SendContent, 'subject' | 'html' | 'plainText'>,
	variables: Record<string, unknown> | undefined
): string[] {
	const used = new Set([
		...variablesWithoutFallback(content.subject),
		...variablesWithoutFallback(content.html),
		...variablesWithoutFallback(content.plainText ?? ''),
	]);
	return [...used].filter((name) => variables?.[name] == null);
}

/**
 * Merge template-side attachments (parsed from the template's `attachments`
 * JSON blob) with request-side attachments (already resolved by the HTTP
 * shell). Template attachments come first; request attachments are appended.
 * Template-side JSON that is not a list of attachments is treated as no
 * template attachments.
 */
export function mergeAttachments(
	templateAttachmentsJson: string | undefined,
	requestAttachments: AttachmentRef[] | undefined
): { filename: string; contentType?: string; url: string }[] | undefined {
	let templateAttachments: { filename: string; contentType?: string; url: string }[] = [];

	if (templateAttachmentsJson) {
		const parsed = decodeJsonText(templateAttachmentsJson, templateAttachmentsValidator);
		if (parsed.ok) {
			templateAttachments = parsed.value.map((a) => ({
				filename: a.filename,
				contentType: a.contentType,
				url: a.url,
			}));
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
