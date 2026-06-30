/**
 * Compatibility scoring — runs against the per-block data the walker collects
 * from registered Block modules. Moved from `@owlat/shared` so it can read
 * directly from the renderer's module registry; the shared package keeps the
 * extension registry but no longer owns per-block data.
 *
 * Cross-block queries that return enriched shapes carry their owning `blockType`
 * explicitly — `PropertyCompatibility` itself does not store one.
 */

import type {
	BlockType,
	ClientSupport,
	FeatureCompatibility,
	PropertyCompatibility,
	BlockCompatibilityScore,
} from '@owlat/shared';
import { emailClientRegistry, emailClients, fullSupport, lookupClientSupport } from '@owlat/shared';
import { featuresFor, propertiesFor, allFeatures, allProperties } from './walker';

/**
 * One tuple, with the block tag re-attached, returned by cross-block queries.
 */
export interface BlockTaggedFeature {
	blockType: BlockType;
	feature: FeatureCompatibility;
}

export interface BlockTaggedProperty {
	blockType: BlockType;
	property: PropertyCompatibility;
}

/**
 * Effective Feature compatibility for a block type. Baseline from the Block
 * module plus any plugin-registered extras.
 */
export const getBlockCompatibility = (blockType: BlockType): readonly FeatureCompatibility[] =>
	featuresFor(blockType);

/** Per-property compatibility for a block type, optionally filtered by property. */
export const getPropertyCompatibility = (
	blockType: BlockType,
	property?: string,
): readonly PropertyCompatibility[] => {
	const all = propertiesFor(blockType);
	return property ? all.filter((p) => p.property === property) : all;
};

/** Properties with `critical` severity for a block type. */
export const getCriticalProperties = (blockType: BlockType): readonly PropertyCompatibility[] =>
	propertiesFor(blockType).filter((p) => p.severity === 'critical');

/** All features (across blocks) with an Owlat workaround. */
export const getHandledFeatures = (): readonly BlockTaggedFeature[] =>
	allFeatures()
		.filter(([, f]) => f.owlatHandled)
		.map(([blockType, feature]) => ({ blockType, feature }));

/** All features (across blocks) that aren't `full` in a given client. */
export const getClientIssues = (client: keyof ClientSupport): readonly BlockTaggedFeature[] =>
	allFeatures()
		.filter(([, f]) => f.support[client] !== 'full')
		.map(([blockType, feature]) => ({ blockType, feature }));

/** All property entries (across blocks) that aren't `full` in a given client. */
export const getClientPropertyIssues = (
	client: keyof ClientSupport,
): readonly BlockTaggedProperty[] =>
	allProperties()
		.filter(([, p]) => p.support[client] !== 'full')
		.map(([blockType, property]) => ({ blockType, property }));

/**
 * Approximate audience reach for a feature's support shape. Custom weights win
 * over the registered client metadata.
 */
export const getAudienceReach = (
	support: ClientSupport,
	customWeights?: Partial<Record<keyof ClientSupport, number>>,
): number => {
	const clients = Object.keys(support) as (keyof ClientSupport)[];
	let totalReach = 0;
	let totalWeight = 0;

	for (const client of clients) {
		const weight =
			customWeights?.[client] ??
			emailClientRegistry.get(client)?.marketSharePercent ??
			0;
		totalWeight += weight;

		const level = lookupClientSupport(support, client);
		if (level === 'full') {
			totalReach += weight;
		} else if (level === 'partial' || level === 'buggy') {
			totalReach += weight * 0.5;
		}
	}

	return totalWeight > 0 ? Math.round((totalReach / totalWeight) * 100) : 0;
};

/**
 * Score a block's configuration against every client. Examines both block-level
 * features and the property-level entries for properties actually present in
 * `properties`.
 */
export const scoreBlockCompatibility = (
	blockType: BlockType,
	properties: Record<string, unknown>,
): BlockCompatibilityScore => {
	const allClients = Object.keys(fullSupport) as (keyof ClientSupport)[];
	const fullSupportClients: (keyof ClientSupport)[] = [];
	const partialSupportClients: (keyof ClientSupport)[] = [];
	const criticalIssues: string[] = [];

	const features = featuresFor(blockType);
	const usedProperties = propertiesFor(blockType).filter(
		(p) => properties[p.property] !== undefined,
	);

	for (const client of allClients) {
		let hasCritical = false;
		let hasPartial = false;

		for (const feat of features) {
			const level = feat.support[client];
			if (level === 'none') {
				if (feat.degradationImpact === 'functional' || feat.degradationImpact === 'hidden') {
					hasCritical = true;
					criticalIssues.push(
						`${emailClients[client]?.name ?? client}: ${feat.feature} — ${feat.fallback}`,
					);
				} else {
					hasPartial = true;
				}
			} else if (level === 'partial' || level === 'buggy') {
				hasPartial = true;
			}
		}

		for (const prop of usedProperties) {
			const level = prop.support[client];
			if (level === 'none' && prop.severity === 'critical') {
				hasCritical = true;
				criticalIssues.push(
					`${emailClients[client]?.name ?? client}: ${prop.property} — ${prop.recommendation}`,
				);
			} else if (level !== 'full') {
				hasPartial = true;
			}
		}

		if (!hasCritical && !hasPartial) {
			fullSupportClients.push(client);
		} else if (!hasCritical) {
			partialSupportClients.push(client);
		}
	}

	let score = 0;
	let totalWeight = 0;
	for (const client of allClients) {
		const weight = emailClients[client]?.marketSharePercent ?? 0;
		totalWeight += weight;
		if (fullSupportClients.includes(client)) {
			score += weight;
		} else if (partialSupportClients.includes(client)) {
			score += weight * 0.7;
		}
	}

	return {
		score: totalWeight > 0 ? Math.round((score / totalWeight) * 100) : 0,
		fullSupportClients,
		partialSupportClients,
		criticalIssues: [...new Set(criticalIssues)],
	};
};
