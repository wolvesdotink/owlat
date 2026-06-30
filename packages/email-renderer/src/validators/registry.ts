/**
 * Block validator registry — the pluggable seam for pre-render validation.
 *
 * Lives in its own module so per-block validator files can import
 * registerBlockValidator without pulling in the side-effect imports from
 * ./index, avoiding circular-import temporal-dead-zone issues.
 *
 * Each block type's validator receives a shared ValidatorContext that
 * gathers issues, threads through accessibility/options state, and exposes
 * a recurse() callback for blocks with nested items (hero, columns,
 * container, accordion).
 */

import { createRegistry } from '@owlat/shared/registry';
import type { EditorBlock, ValidationIssue } from '@owlat/shared';
import type { ValidateOptions } from '../validator';

/**
 * Mutable state passed to every block validator during a single
 * validateBlocks() invocation. Validators push to ctx.issues and may update
 * ctx.state when a check spans the whole document (e.g. heading hierarchy).
 */
export interface ValidatorContext {
	issues: ValidationIssue[];
	options: ValidateOptions | undefined;
	depth: number;
	state: {
		hasTextBlock: boolean;
		headingLevels: number[];
	};
	/** Recurse into a nested item using the same validator pipeline. */
	recurse: (block: EditorBlock, depth: number) => void;
}

/**
 * A pluggable per-block validator.
 *
 * Receives the block and a ValidatorContext. Mutates ctx (issues, state)
 * directly rather than returning a value, so cross-block aggregation (text
 * detection, heading hierarchy, recursion) stays simple.
 */
export interface BlockValidator {
	type: string;
	validate(block: EditorBlock, ctx: ValidatorContext): void;
}

/**
 * Registry of installed block validators. Keys are block type strings.
 *
 * Built-in validators register themselves at module load via ./builtins,
 * which is side-effect imported by ./index.
 */
export const blockValidators = createRegistry<string, BlockValidator>('blockValidators');

/**
 * Install a block validator. Replaces any prior validator for the same type.
 */
export function registerBlockValidator(validator: BlockValidator): void {
	blockValidators.register(validator.type, validator);
}

/**
 * Remove a block validator by type. Returns true if anything was removed.
 */
export function unregisterBlockValidator(type: string): boolean {
	return blockValidators.unregister(type);
}

// ---------------------------------------------------------------------------
// Color contrast helpers (used by per-block validators)
// ---------------------------------------------------------------------------

/**
 * WCAG 2.0 contrast ratio between two hex colors.
 */
export const getContrastRatio = (color1: string, color2: string): number => {
	const lum1 = getRelativeLuminance(color1);
	const lum2 = getRelativeLuminance(color2);
	const lighter = Math.max(lum1, lum2);
	const darker = Math.min(lum1, lum2);
	return (lighter + 0.05) / (darker + 0.05);
};

const getRelativeLuminance = (hex: string): number => {
	const rgb = hexToRgb(hex);
	if (!rgb) return 0;
	const [r, g, b] = rgb.map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

const hexToRgb = (hex: string): [number, number, number] | null => {
	const clean = hex.replace('#', '');
	if (clean.length === 3) {
		return [
			parseInt(clean[0]! + clean[0]!, 16),
			parseInt(clean[1]! + clean[1]!, 16),
			parseInt(clean[2]! + clean[2]!, 16),
		];
	}
	if (clean.length === 6) {
		return [
			parseInt(clean.substring(0, 2), 16),
			parseInt(clean.substring(2, 4), 16),
			parseInt(clean.substring(4, 6), 16),
		];
	}
	return null;
};
