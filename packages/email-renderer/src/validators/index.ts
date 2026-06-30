/**
 * Validator registry — public entry point.
 *
 * Built-in validators no longer live here; each Block module's `validate?`
 * method is auto-bridged into the registry by `registerBlockModule` (see
 * `../blocks/_registry.ts`). Custom validators can still call
 * `registerBlockValidator` directly.
 */

export {
	blockValidators,
	registerBlockValidator,
	unregisterBlockValidator,
	getContrastRatio,
} from './registry';
export type { BlockValidator, ValidatorContext } from './registry';
