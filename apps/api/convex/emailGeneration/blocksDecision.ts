/**
 * Generated outline → editor blocks: the decision core of AI email drafting.
 *
 * Takes the model's closed outline (`outputSchema.ts`) and returns the draft
 * to store: clamped name, subject and preview text, the `EditorBlock[]`, and
 * for a transactional email the `dataVariablesSchema` that matches the
 * variables the content uses. Pure: the caller injects `newId`.
 *
 * The model writes plain text with three inline marks (**bold**, *italic*,
 * [label](url)); everything else it writes is escaped. Links and buttons keep
 * only http(s), mailto and `{{variable}}` targets. Merge tags the email kind
 * cannot fill are dropped (their fallback text stays), so a draft never ships
 * a token that renders blank at send time.
 */

import { moduleFor, validateBlocks } from '@owlat/email-renderer';
import { escapeHtml } from '@owlat/shared/html';
import { DEFAULT_BLOCK_MARGIN, DEFAULT_BLOCK_PADDING } from '@owlat/shared/emailDefaults';
import { toSlug, type BlockType, type EditorBlock } from '@owlat/shared';
import type { BrandKitDesign } from '@owlat/shared/brandKit';
import {
	applyBrandKit,
	brandFooterBlocks,
	brandLogoBlock,
	type BrandLogos,
} from '@owlat/shared/brandKitBlocks';
import {
	GENERATION_LIMITS as LIMITS,
	type GeneratedEmail,
	type GeneratedSection,
	type VariableType,
} from './outputSchema';

/** What is being drafted. A campaign's email is a marketing template. */
export type GenerationKind = 'template' | 'transactional' | 'campaign';

/**
 * The merge tags a marketing send fills for every contact
 * (`campaigns/pageBucketPlan.ts` builds `contactInfo` from exactly these).
 * The unsubscribe link is left out on purpose: every marketing send appends
 * its own footer with it.
 */
export const MARKETING_MERGE_TAGS = ['firstName', 'lastName', 'email'] as const;

/** A `{{name}}` or `{{name|'fallback'}}` token, the send path's grammar. */
const TOKEN = /\{\{(\w+)(?:\|'([^']*)')?\}\}/g;
const VARIABLE_NAME = /^[A-Za-z_]\w{0,63}$/;
const SAFE_URL = /^(?:https?:\/\/|mailto:)[^\s"'<>]+$/i;
const LONE_TOKEN = /^\{\{\w+\}\}$/;
/** What a button links to when the model gave no usable address: the editor's own blank. */
export const PLACEHOLDER_URL = 'https://';

export interface DraftPlan {
	name: string;
	subject: string;
	previewText: string;
	language: string;
	/** Transactional only; the commit makes it unique. */
	slug: string | null;
	blocks: EditorBlock[];
	dataVariablesSchema: Record<string, VariableType> | null;
	optionalDataVariables: string[];
	/** Merge tags the content used that this kind cannot fill, removed from the draft. */
	droppedVariables: string[];
	/** Sections past the cap, or empty ones, that were left out. */
	droppedSections: number;
}

export type DraftPlanResult =
	| { ok: true; plan: DraftPlan }
	| { ok: false; reason: 'no_subject' | 'no_content' | 'invalid_blocks' };

function clamp(text: string | null | undefined, max: number): string {
	const value = (text ?? '').replace(/\s+/g, ' ').trim();
	return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function clampMultiline(text: string | null | undefined, max: number): string {
	const value = (text ?? '').replace(/\r\n?/g, '\n').trim();
	return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** The variables a draft of this kind may keep, from what the model declared. */
export function allowedVariables(
	kind: GenerationKind,
	declared: GeneratedEmail['variables']
): Map<string, { type: VariableType; isOptional: boolean }> {
	const allowed = new Map<string, { type: VariableType; isOptional: boolean }>();
	if (kind !== 'transactional') {
		for (const tag of MARKETING_MERGE_TAGS) allowed.set(tag, { type: 'string', isOptional: true });
		return allowed;
	}
	for (const variable of declared.slice(0, LIMITS.variables)) {
		if (!VARIABLE_NAME.test(variable.name) || allowed.has(variable.name)) continue;
		allowed.set(variable.name, { type: variable.type, isOptional: variable.optional });
	}
	return allowed;
}

/**
 * Remove every token whose name is not allowed, keeping its fallback text.
 * `dropped` and `used` collect names across calls.
 */
export function filterTokens(
	text: string,
	allowed: ReadonlySet<string>,
	dropped: Set<string>,
	used: Set<string>
): string {
	return text.replace(TOKEN, (match, name: string, fallback: string | undefined) => {
		if (allowed.has(name)) {
			used.add(name);
			return match;
		}
		dropped.add(name);
		return fallback ?? '';
	});
}

/** A link target the draft may keep, or null. */
export function safeUrl(url: string | null | undefined): string | null {
	const value = (url ?? '').trim();
	if (!value || value.length > 2_000) return null;
	return SAFE_URL.test(value) || LONE_TOKEN.test(value) ? value : null;
}

/**
 * Plain text with **bold**, *italic* and [label](url) → inline HTML. Tokens
 * are lifted out before escaping (an escaped quote would break a
 * `{{name|'fallback'}}`), then put back.
 */
export function inlineHtml(text: string): string {
	const tokens: string[] = [];
	const lifted = text.replace(/[\uE000\uE001]/g, '').replace(TOKEN, (match) => {
		tokens.push(match);
		return `\uE000${tokens.length - 1}\uE001`;
	});
	let html = escapeHtml(lifted);
	html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, rawUrl: string) => {
		const url = safeUrl(restoreTokens(rawUrl, tokens).replace(/&amp;/g, '&'));
		return url ? `<a href="${escapeHtml(url)}">${label}</a>` : label;
	});
	html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
	html = html.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>');
	html = html.replace(/\n/g, '<br>');
	return restoreTokens(html, tokens);
}

function restoreTokens(text: string, tokens: readonly string[]): string {
	return text.replace(/\uE000(\d+)\uE001/g, (_m, index: string) => tokens[Number(index)] ?? '');
}

const HEADING_SIZE = { h1: 28, h2: 22, h3: 18 } as const;

function defaults<T extends BlockType>(type: T) {
	const content = moduleFor(type)?.createDefault?.({});
	if (!content) throw new Error(`No default content for block type ${type}`);
	return { ...content, ...DEFAULT_BLOCK_PADDING, ...DEFAULT_BLOCK_MARGIN };
}

/** One section → its block, or null when it carries nothing to show. */
function sectionBlock(
	section: GeneratedSection,
	clean: (text: string) => string,
	newId: () => string
): EditorBlock | null {
	switch (section.kind) {
		case 'heading': {
			const text = clean(clamp(section.text, LIMITS.headingChars));
			if (!text) return null;
			const level = section.level ?? 'h2';
			return {
				id: newId(),
				type: 'text',
				content: {
					...defaults('text'),
					html: `<${level}>${inlineHtml(text)}</${level}>`,
					blockType: level,
					fontSize: HEADING_SIZE[level],
					fontWeight: 700,
				},
			};
		}
		case 'paragraph': {
			const paragraphs = clean(clampMultiline(section.text, LIMITS.paragraphChars))
				.split(/\n{2,}/)
				.map((part) => part.trim())
				.filter(Boolean);
			if (paragraphs.length === 0) return null;
			return {
				id: newId(),
				type: 'text',
				content: {
					...defaults('text'),
					html: paragraphs.map((part) => `<p>${inlineHtml(part)}</p>`).join(''),
					blockType: 'paragraph',
				},
			};
		}
		case 'button': {
			const label = clean(clamp(section.text, LIMITS.buttonLabelChars));
			if (!label) return null;
			return {
				id: newId(),
				type: 'button',
				content: {
					...defaults('button'),
					text: label,
					url: safeUrl(clean(section.url ?? '')) ?? PLACEHOLDER_URL,
				},
			};
		}
		case 'list': {
			const items = (section.items ?? [])
				.slice(0, LIMITS.listItems)
				.map((item) => clean(clamp(item, LIMITS.listItemChars)))
				.filter(Boolean)
				.map(inlineHtml);
			if (items.length === 0) return null;
			return {
				id: newId(),
				type: 'list',
				content: { ...defaults('list'), items, listType: section.ordered ? 'numbered' : 'bullet' },
			};
		}
		case 'divider':
			return { id: newId(), type: 'divider', content: defaults('divider') };
		case 'spacer':
			return { id: newId(), type: 'spacer', content: { height: 24 } };
	}
}

/** A language code the draft is stored under: the model's, else the caller's default. */
export function draftLanguage(modelLanguage: string, fallback: string): string {
	const match = /^([a-z]{2})(?:[-_][a-z]{2,4})?$/i.exec(modelLanguage.trim());
	return match ? match[1]!.toLowerCase() : fallback;
}

/** The slug a transactional draft asks for, before the commit makes it unique. */
export function draftSlug(modelSlug: string | null, name: string): string {
	const slug = toSlug(modelSlug || name)
		.slice(0, LIMITS.slugChars)
		.replace(/-+$/, '');
	return slug || 'generated-email';
}

/** The model's outline → the draft to store, or why it cannot be stored. */
export function planDraft(
	email: GeneratedEmail,
	opts: { kind: GenerationKind; fallbackLanguage: string; newId: () => string }
): DraftPlanResult {
	const allowed = allowedVariables(opts.kind, email.variables);
	const allowedNames = new Set(allowed.keys());
	const dropped = new Set<string>();
	const used = new Set<string>();
	const clean = (text: string) =>
		filterTokens(text, allowedNames, dropped, used)
			.replace(/[ \t]{2,}/g, ' ')
			.trim();

	const subject = clean(clamp(email.subject, LIMITS.subjectChars));
	if (!subject) return { ok: false, reason: 'no_subject' };
	const name = clamp(email.name, LIMITS.nameChars) || subject.slice(0, LIMITS.nameChars);
	const previewText = clean(clamp(email.previewText, LIMITS.previewTextChars));

	const kept = email.sections.slice(0, LIMITS.sections);
	const blocks: EditorBlock[] = [];
	for (const section of kept) {
		const block = sectionBlock(section, clean, opts.newId);
		if (block) blocks.push(block);
	}
	const hasText = blocks.some((block) => block.type === 'text' || block.type === 'list');
	if (!hasText) return { ok: false, reason: 'no_content' };
	if (!validateBlocks(blocks).valid) return { ok: false, reason: 'invalid_blocks' };

	let dataVariablesSchema: Record<string, VariableType> | null = null;
	const optionalDataVariables: string[] = [];
	if (opts.kind === 'transactional') {
		dataVariablesSchema = {};
		for (const [variable, spec] of allowed) {
			if (!used.has(variable)) continue;
			dataVariablesSchema[variable] = spec.type;
			if (spec.isOptional) optionalDataVariables.push(variable);
		}
	}

	return {
		ok: true,
		plan: {
			name,
			subject,
			previewText,
			language: draftLanguage(email.language, opts.fallbackLanguage),
			slug: opts.kind === 'transactional' ? draftSlug(email.slug, name) : null,
			blocks,
			dataVariablesSchema,
			optionalDataVariables,
			droppedVariables: [...dropped].sort(),
			droppedSections: email.sections.length - blocks.length,
		},
	};
}

/**
 * The stored blocks of a draft: the brand kit's logo on top and its footer at
 * the bottom, as a new blank email gets them, then the kit's colours, fonts
 * and button style over everything. A transactional email takes only the
 * logo and the footer text (its editor offers no social block). Without a
 * configured kit the blocks come back as they are.
 */
export function brandDraftBlocks(
	blocks: EditorBlock[],
	kit: { design: BrandKitDesign; logos: BrandLogos },
	kind: GenerationKind,
	newId: () => string
): EditorBlock[] {
	if (!kit.design.isConfigured) return blocks;
	const logo = brandLogoBlock(kit.design, kit.logos, newId);
	const footer = brandFooterBlocks(kit.design, newId).filter(
		(block) => kind !== 'transactional' || block.type === 'text'
	);
	const framed = [...(logo ? [logo] : []), ...blocks, ...footer];
	return applyBrandKit(framed, kit.design).blocks;
}
