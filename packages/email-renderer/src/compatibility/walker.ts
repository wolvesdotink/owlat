/**
 * Compatibility walker — gathers Feature compatibility and Property compatibility
 * from every registered Block module to drive scoring and audience-reach math.
 *
 * Mirrors the HTML/plaintext walker pattern: thin dispatcher, per-module data
 * ownership. scoring.ts reads through it.
 *
 * Plugin extensions registered through `blockCompatibilityRegistry` in
 * `@owlat/shared` are merged on top of each module's baseline `features` list.
 */

import type { BlockType, FeatureCompatibility, PropertyCompatibility } from '@owlat/shared';
import { mergeBlockCompatibility } from '@owlat/shared';
import { moduleFor } from '../blocks/_registry';

/**
 * Feature-level compatibility for a single block type. Baseline from the
 * Block module merged with any plugin-registered extras.
 */
export const featuresFor = (blockType: BlockType): readonly FeatureCompatibility[] => {
	const mod = moduleFor(blockType);
	const baseline = mod?.compatibility?.features ?? [];
	return mergeBlockCompatibility(blockType, [...baseline]);
};

/**
 * Property-level compatibility for a single block type. Module-owned;
 * plugin extension for properties is not yet a supported seam (no caller
 * needs it). Add a registry hook here if a second adapter shows up.
 */
export const propertiesFor = (blockType: BlockType): readonly PropertyCompatibility[] => {
	const mod = moduleFor(blockType);
	return mod?.compatibility?.properties ?? [];
};
