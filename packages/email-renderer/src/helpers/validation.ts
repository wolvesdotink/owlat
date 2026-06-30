/**
 * Validation helpers used by Block modules' `validate?` methods.
 *
 * Combines the field-check pattern from the historical
 * `packages/shared/src/validation/blockSchemas.ts` (shape) and the
 * mutation-on-`ctx.issues` pattern from
 * `packages/email-renderer/src/validators/builtins.ts` (semantic).
 */

import type { GradientBackground } from '@owlat/shared';
import type { ValidationIssue } from '../validator';

export interface FieldRule {
	field: string;
	check: (value: unknown) => boolean;
	code: string;
	message: string;
}

const readField = (content: Record<string, unknown>, field: string): unknown => {
	if (!field.includes('.')) return content[field];
	return field
		.split('.')
		.reduce<unknown>(
			(obj, key) => (obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>)[key] : undefined),
			content,
		);
};

/**
 * Push a severity:'error' issue for each rule that fails its `check`. Used by
 * block modules to validate the shape of incoming content (runtime guard
 * against malformed data that bypassed the TypeScript types).
 */
export const checkShape = (
	content: Record<string, unknown>,
	rules: FieldRule[],
	blockId: string,
	blockType: string,
	issues: ValidationIssue[],
): void => {
	for (const { field, check, code, message } of rules) {
		if (!check(readField(content, field))) {
			issues.push({ blockId, blockType, severity: 'error', code, message });
		}
	}
};

/**
 * Push an `OUTLOOK_GRADIENT_MULTI_STOP` warning when a gradient declares more
 * than two color stops — Outlook's VML gradient fill only supports two colors,
 * so any extra stops silently drop. Used by every block that renders a
 * gradient background (button, container, hero). No-op when the gradient is
 * absent or has ≤2 stops.
 */
export const checkGradientStopLimit = (
	gradient: GradientBackground | undefined,
	blockId: string,
	blockType: string,
	issues: ValidationIssue[],
): void => {
	if (gradient && gradient.stops && gradient.stops.length > 2) {
		issues.push({
			blockId,
			blockType,
			severity: 'warning',
			code: 'OUTLOOK_GRADIENT_MULTI_STOP',
			message: `Gradient has ${gradient.stops.length} stops — Outlook VML only supports 2-color gradients. Extra stops will be ignored.`,
		});
	}
};

export const isString = (v: unknown): v is string => typeof v === 'string';
export const isNumber = (v: unknown): v is number => typeof v === 'number' && !Number.isNaN(v);
export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
export const isArray = (v: unknown): v is unknown[] => Array.isArray(v);
export const isObject = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === 'object' && !Array.isArray(v);
export const isOneOf = <T extends string>(v: unknown, values: readonly T[]): v is T =>
	isString(v) && (values as readonly string[]).includes(v);
