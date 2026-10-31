/**
 * Compatibility walker — gathers Feature compatibility and Property compatibility
 * from every registered Block module to drive scoring and audience-reach math.
 *
 * Mirrors the HTML/plaintext walker pattern: thin dispatcher, per-module data
 * ownership. scoring.ts reads through it.
 */

import type { BlockType, FeatureCompatibility, PropertyCompatibility } from '@owlat/shared';
import { moduleFor } from '../blocks/_registry';

/** Feature-level compatibility for a single block type. Module-owned. */
export const featuresFor = (blockType: BlockType): readonly FeatureCompatibility[] => {
	const mod = moduleFor(blockType);
	return mod?.compatibility?.features ?? [];
};

/** Property-level compatibility for a single block type. Module-owned. */
export const propertiesFor = (blockType: BlockType): readonly PropertyCompatibility[] => {
	const mod = moduleFor(blockType);
	return mod?.compatibility?.properties ?? [];
};
