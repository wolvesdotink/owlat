/**
 * Pre-render block validation orchestrator.
 *
 * Iterates `blocks`, dispatches each one to its Block module's `validate?` via
 * the `blockValidators` registry (auto-bridged by `registerBlockModule`), and
 * runs document-level cross-block checks (heading hierarchy, compliance,
 * image-only fallback).
 *
 * Per-block rules (shape, semantic, Outlook quirks) all live inside each
 * block module's `validate?` — see `packages/email-renderer/src/blocks/<type>/`.
 */

import type { EditorBlock, TextBlockContent, ValidationIssue } from '@owlat/shared';
import { blockValidators, type ValidatorContext } from './validators';
// Side-effect: ensure built-in Block modules' `validate?` methods are
// auto-bridged into `blockValidators` before this orchestrator runs.
import './blocks/_builtin-modules';

export type { ValidationIssue };

export interface ValidateOptions {
	/** Enable accessibility audit checks */
	accessibilityAudit?: boolean;
	/**
	 * Validation strictness level:
	 * - 'skip': Return immediately with valid=true, no checks (production performance)
	 * - 'soft': Collect all issues as warnings/info, never treat anything as error (default)
	 * - 'strict': Treat error-level issues as errors, throw ValidationError if any found
	 */
	level?: 'skip' | 'soft' | 'strict';
}

/**
 * Error thrown when strict validation finds error-level issues.
 */
export class ValidationError extends Error {
	issues: ValidationIssue[];
	constructor(issues: ValidationIssue[]) {
		const errorIssues = issues.filter((i) => i.severity === 'error');
		super(`Validation failed with ${errorIssues.length} error(s): ${errorIssues.map((i) => i.message).join('; ')}`);
		this.name = 'ValidationError';
		this.issues = issues;
	}
}

export const validateBlocks = (blocks: EditorBlock[], options?: ValidateOptions): { valid: boolean; issues: ValidationIssue[] } => {
	const level = options?.level;

	if (level === 'skip') {
		return { valid: true, issues: [] };
	}

	const issues: ValidationIssue[] = [];
	const state = { hasTextBlock: false, headingLevels: [] as number[] };

	const validate = (block: EditorBlock, depth: number): void => {
		const ctx: ValidatorContext = { issues, options, depth, state, recurse: validate };
		const validator = blockValidators.get(block.type);
		if (validator) {
			validator.validate(block, ctx);
		}
	};

	for (const block of blocks) {
		validate(block, 0);
	}

	// Document-level: anti-spam compliance (CAN-SPAM/GDPR)
	const allHtml = blocks
		.filter((b) => b.type === 'text')
		.map((b) => (b.content as TextBlockContent).html || '')
		.join(' ');
	const hasUnsubscribe = /unsubscribe|opt[\s-]?out|manage[\s-]?preferences/i.test(allHtml);
	if (!hasUnsubscribe && blocks.length > 0) {
		issues.push({
			severity: 'info',
			code: 'COMPLIANCE_NO_UNSUBSCRIBE',
			message: 'No unsubscribe link detected — CAN-SPAM/GDPR requires a clear opt-out mechanism. Gmail/Yahoo require List-Unsubscribe headers for bulk senders (header configuration is outside renderer scope).',
		});
	}

	// Document-level: image-only email warning
	if (!state.hasTextBlock && blocks.length > 0) {
		const hasOnlyImages = blocks.every((b) => b.type === 'image' || b.type === 'spacer' || b.type === 'divider');
		if (hasOnlyImages) {
			issues.push({
				severity: 'warning',
				code: 'EMAIL_IMAGE_ONLY',
				message: 'Email contains no text blocks — image-only emails have poor deliverability',
			});
		}
	}

	// Document-level: heading hierarchy check (accessibility audit)
	if (options?.accessibilityAudit && state.headingLevels.length > 0) {
		for (let i = 1; i < state.headingLevels.length; i++) {
			if (state.headingLevels[i]! > state.headingLevels[i - 1]! + 1) {
				issues.push({
					severity: 'warning',
					code: 'A11Y_HEADING_SKIP',
					message: `Heading level jumps from h${state.headingLevels[i - 1]} to h${state.headingLevels[i]} — avoid skipping heading levels`,
				});
			}
		}
		if (state.headingLevels[0] !== 1) {
			issues.push({
				severity: 'info',
				code: 'A11Y_NO_H1',
				message: `First heading is h${state.headingLevels[0]} — consider starting with h1 for screen reader hierarchy`,
			});
		}
	}

	const hasErrors = issues.some((i) => i.severity === 'error');

	if (level === 'strict' && hasErrors) {
		throw new ValidationError(issues);
	}
	if (level === 'soft') {
		return { valid: true, issues };
	}
	return { valid: !hasErrors, issues };
};
