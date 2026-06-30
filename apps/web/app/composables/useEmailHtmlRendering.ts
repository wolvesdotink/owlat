import { type EditorBlock, type EmailTheme, type VariableType } from '@owlat/email-builder';
import { renderEmailHtml } from '@owlat/email-renderer';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export interface RenderOptions {
	theme?: EmailTheme;
	variableType: VariableType;
	minify?: boolean;
}

interface LanguageRenderContent {
	content: string;
	subject: string;
}

interface RenderedTranslation {
	htmlContent: string;
	subject: string;
}

export type EmailIdentifier =
	| { emailType: 'marketing'; emailId: Id<'emailTemplates'> }
	| { emailType: 'transactional'; emailId: Id<'transactionalEmails'> };

function parseBlocks(content: string): EditorBlock[] {
	try {
		const parsed = JSON.parse(content || '[]');
		return Array.isArray(parsed) ? (parsed as EditorBlock[]) : [];
	} catch {
		return [];
	}
}

export function useEmailHtmlRendering() {
	const renderBlocksToHtml = (blocks: EditorBlock[], options: RenderOptions): string => {
		return renderEmailHtml(blocks, {
			theme: options.theme,
			variableType: options.variableType,
			minify: options.minify,
		});
	};

	const renderContentToHtml = (content: string, options: RenderOptions): string => {
		const blocks = parseBlocks(content);
		return renderBlocksToHtml(blocks, options);
	};

	const loadLanguageContentForEmail = async (
		identifier: EmailIdentifier,
		language: string
	): Promise<LanguageRenderContent | null> => {
		const convex = useConvex();
		if (!convex) {
			throw new Error('Convex client is not available');
		}

		if (identifier.emailType === 'marketing') {
			const result = await convex.query(api.emailTemplates.i18n.getForLanguage, {
				templateId: identifier.emailId,
				language,
			});
			if (!result) return null;
			return { content: result.content, subject: result.subject };
		}

		const result = await convex.query(api.transactional.translations.getForLanguage, {
			id: identifier.emailId,
			language,
		});
		if (!result) return null;
		return { content: result.content, subject: result.subject };
	};

	const buildHtmlTranslations = async (
		languages: string[],
		loadLanguageContent: (language: string) => Promise<LanguageRenderContent | null>,
		options: RenderOptions
	): Promise<Record<string, RenderedTranslation>> => {
		if (languages.length === 0) {
			return {};
		}

		const entries = await Promise.all(
			languages.map(async (language) => {
				const languageContent = await loadLanguageContent(language);
				if (!languageContent) return null;
				const htmlContent = renderContentToHtml(languageContent.content, options);
				return [language, { htmlContent, subject: languageContent.subject }] as const;
			})
		);

		return Object.fromEntries(
			entries.filter(
				(entry): entry is readonly [string, RenderedTranslation] => entry !== null
			)
		);
	};

	const buildHtmlTranslationsForEmail = async (
		identifier: EmailIdentifier,
		supportedLanguages: string[],
		defaultLanguage: string,
		options: RenderOptions
	): Promise<Record<string, RenderedTranslation>> => {
		const languages = supportedLanguages.filter((lang) => lang !== defaultLanguage);
		return await buildHtmlTranslations(
			languages,
			(language) => loadLanguageContentForEmail(identifier, language),
			options
		);
	};

	return {
		renderBlocksToHtml,
		renderContentToHtml,
		loadLanguageContentForEmail,
		buildHtmlTranslations,
		buildHtmlTranslationsForEmail,
	};
}
