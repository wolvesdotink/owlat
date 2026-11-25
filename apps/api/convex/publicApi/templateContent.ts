/**
 * The content check an API write of a transactional email or saved block
 * answers with: the renderer's own block validation (`validateBlocks`), the
 * block types this server knows, the warnings a render raises and whether the
 * stored row would fit. It runs in the HTTP action before the write, on the
 * sanitised blocks the write will store, so a caller learns what to fix
 * without a render round trip.
 *
 * The write itself still goes through the editor's path (sanitise, render,
 * scan, audit); this check only adds what an API caller cannot see.
 */

import { moduleFor, renderEmailHtml, validateBlocks } from '@owlat/email-renderer';
import type { ContentIssue } from '@owlat/public-contract';
import { childBlockLists, type BlockTreeNode } from '@owlat/shared/blockTree';
import { parseContentBlocks } from '../emailBlocks/consumers';
import { sanitizeStoredBlocksJson } from '../lib/emailContentSanitize';

/**
 * Most bytes a transactional email's stored content may take. A Convex
 * document holds at most 1 MiB, and the row also carries its rendered HTML,
 * one per language, and the translation overlays; the margin leaves room for
 * the other columns.
 */
export const MAX_STORED_EMAIL_BYTES = 900_000;

/** Renderer warnings that restate a `validateBlocks` issue the check already lists. */
const VALIDATION_WARNING_PREFIX = 'Block validation:';

export interface ContentCheck {
	/** The blocks as the write stores them: sanitised, every block with an id. */
	blocks: BlockTreeNode[];
	/** The stored JSON of `blocks`. */
	contentJson: string;
	/** Every issue, errors first. */
	issues: ContentIssue[];
	/** The first error, which refuses the write; `null` when there is none. */
	firstError: ContentIssue | null;
	/** Bytes of the rendered default-language HTML. */
	htmlBytes: number;
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

function unknownTypeIssues(blocks: readonly BlockTreeNode[]): ContentIssue[] {
	const issues: ContentIssue[] = [];
	const pending = [...blocks];
	for (let block = pending.pop(); block; block = pending.pop()) {
		if (!moduleFor(block.type as Parameters<typeof moduleFor>[0])) {
			issues.push({
				severity: 'error',
				code: 'UNKNOWN_BLOCK_TYPE',
				message: `Unknown block type "${block.type}"`,
				blockId: block.id,
				blockType: block.type,
			});
			continue;
		}
		for (const list of childBlockLists(block)) pending.push(...list);
	}
	return issues;
}

/**
 * Check `blocks` as a write would store them. Variables render as a
 * transactional email's data variables; a saved block has none of its own.
 */
export function checkContent(blocks: readonly unknown[]): ContentCheck {
	const contentJson = sanitizeStoredBlocksJson(JSON.stringify(blocks));
	// The reader every renderer path uses, so the ids here are the ones a read
	// of the stored email answers with.
	const stored = parseContentBlocks(contentJson) as BlockTreeNode[];

	const unknown = unknownTypeIssues(stored);
	const validation = unknown.length === 0 ? validationIssues(stored) : [];

	const warnings: ContentIssue[] = [];
	let htmlBytes = 0;
	if (unknown.length === 0) {
		try {
			const html = renderEmailHtml(stored as Parameters<typeof renderEmailHtml>[0], {
				variableType: 'data',
				onWarning: (warning) => {
					if (warning.startsWith(VALIDATION_WARNING_PREFIX)) return;
					warnings.push({
						severity: 'warning',
						code: 'RENDER_WARNING',
						message: warning,
						blockId: null,
						blockType: null,
					});
				},
			});
			htmlBytes = byteLength(html);
		} catch {
			warnings.push({
				severity: 'error',
				code: 'RENDER_FAILED',
				message: 'The blocks could not be rendered.',
				blockId: null,
				blockType: null,
			});
		}
	}

	const issues = [...unknown, ...validation, ...warnings].sort(
		(a, b) => severityRank(a) - severityRank(b)
	);
	const firstError = issues.find((issue) => issue.severity === 'error') ?? null;
	return { blocks: stored, contentJson, issues, firstError, htmlBytes };
}

/**
 * `validateBlocks` over the blocks. A semantic check can throw on a field of
 * the wrong type that the shape check has already reported, so a throw is
 * traced to the root block that causes it and reported as that block's error.
 */
function validationIssues(blocks: readonly BlockTreeNode[]): ContentIssue[] {
	const validate = (list: readonly BlockTreeNode[]) =>
		validateBlocks(list as Parameters<typeof validateBlocks>[0]).issues.map(
			(issue): ContentIssue => ({
				severity: issue.severity,
				code: issue.code,
				message: issue.message,
				blockId: issue.blockId ?? null,
				blockType: issue.blockType ?? null,
			})
		);
	try {
		return validate(blocks);
	} catch {
		const issues: ContentIssue[] = [];
		for (const block of blocks) {
			try {
				validate([block]);
			} catch {
				issues.push({
					severity: 'error',
					code: 'INVALID_BLOCK',
					message: 'The block content does not have the shape of its type',
					blockId: block.id,
					blockType: block.type,
				});
			}
		}
		return issues.length > 0
			? issues
			: [
					{
						severity: 'error',
						code: 'INVALID_BLOCK',
						message: 'The blocks could not be checked',
						blockId: null,
						blockType: null,
					},
				];
	}
}

function severityRank(issue: ContentIssue): number {
	return issue.severity === 'error' ? 0 : issue.severity === 'warning' ? 1 : 2;
}

/**
 * About how many bytes a transactional email's row needs for its content: the
 * blocks, the translation overlays, and the rendered HTML once per language.
 */
export function estimatedStoredBytes(
	check: ContentCheck,
	translationsJson: string,
	languageCount: number
): number {
	return (
		byteLength(check.contentJson) +
		byteLength(translationsJson) +
		check.htmlBytes * Math.max(1, languageCount)
	);
}
