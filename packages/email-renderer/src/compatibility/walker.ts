/**
 * Compatibility walker — gathers Feature compatibility and Property compatibility
 * from every registered Block module to drive scoring, audience-reach math, and
 * the builder UI's limitation summaries.
 *
 * Mirrors the HTML/plaintext walker pattern: thin dispatcher, per-module data
 * ownership. The walker is the only consumer that needs to know how to enumerate
 * blocks — scoring.ts and ui.ts read through it.
 *
 * Plugin extensions registered through `blockCompatibilityRegistry` in
 * `@owlat/shared` are merged on top of each module's baseline `features` list.
 */

import type { BlockType, FeatureCompatibility, PropertyCompatibility } from '@owlat/shared';
import { mergeBlockCompatibility } from '@owlat/shared';
import { moduleFor, registeredBlockTypes } from '../blocks/_registry';

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

/** Every registered block type in the order modules were registered. */
export const allBlockTypes = (): readonly BlockType[] =>
	registeredBlockTypes() as readonly BlockType[];

/**
 * Cross-block feature view: one tuple per (blockType, feature). Used by
 * client-issue and Owlat-handled queries that don't start from a single block.
 */
export const allFeatures = (): ReadonlyArray<readonly [BlockType, FeatureCompatibility]> => {
	const out: Array<readonly [BlockType, FeatureCompatibility]> = [];
	for (const t of allBlockTypes()) {
		for (const f of featuresFor(t)) {
			out.push([t, f]);
		}
	}
	return out;
};

/**
 * Cross-block property view: one tuple per (blockType, property). Used by
 * client-property-issue queries that report which blocks degrade where.
 */
export const allProperties = (): ReadonlyArray<readonly [BlockType, PropertyCompatibility]> => {
	const out: Array<readonly [BlockType, PropertyCompatibility]> = [];
	for (const t of allBlockTypes()) {
		for (const p of propertiesFor(t)) {
			out.push([t, p]);
		}
	}
	return out;
};
