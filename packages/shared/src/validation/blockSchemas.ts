/**
 * Block validation types.
 *
 * The block-shape and semantic validation rules previously living here have
 * moved into per-block `validate?` methods inside each Block module in
 * `packages/email-renderer/src/blocks/<type>/`. The orchestrator is
 * `packages/email-renderer/src/validator.ts`. This file now exists only as
 * the type-home for `ValidationIssue` — the issue shape every validator
 * produces.
 */

/**
 * Semantic / shape validation issue produced by `validateBlocks()` (from
 * `@owlat/email-renderer`) or by any custom Block module's `validate?`.
 */
export interface ValidationIssue {
	blockId?: string;
	blockType?: string;
	severity: 'error' | 'warning' | 'info';
	code: string;
	message: string;
}
