/**
 * Builder UI helpers — produce tooltip-ready summaries of where a block (or
 * one of its properties) degrades, plus a "safe properties" hint. Reads through
 * the walker so a custom Block module's compat shows up automatically.
 */

import type {
	BlockType,
	ClientSupport,
	CompatibilityFix,
	PropertyCompatibility,
	SupportLevel,
} from '@owlat/shared';
import { emailClients, fullSupport } from '@owlat/shared';
import { featuresFor, propertiesFor } from './walker';

export interface BlockLimitation {
	client: string;
	clientIcon: string;
	issue: string;
	severity: 'critical' | 'warning' | 'info';
	audiencePercent: number;
	fix?: CompatibilityFix;
	canIEmailUrl?: string;
}

const clientIconMap: Record<keyof ClientSupport, string> = {
	gmail: 'gmail',
	gmailApp: 'gmail',
	outlookDesktop: 'outlook',
	outlook365: 'outlook',
	outlookNew: 'outlook',
	outlookMac: 'outlook',
	appleMail: 'apple',
	iosMail: 'apple',
	yahooMail: 'yahoo',
	samsungMail: 'samsung',
	thunderbird: 'thunderbird',
	protonMail: 'protonmail',
};

/** Human-readable limitation summary for builder UI tooltip. */
export const getBlockLimitationSummary = (
	blockType: BlockType,
	properties: Record<string, unknown>,
): readonly BlockLimitation[] => {
	const limitations: BlockLimitation[] = [];
	const features = featuresFor(blockType);
	const usedProps = propertiesFor(blockType).filter(
		(p) => properties[p.property] !== undefined,
	);

	const clients = Object.keys(fullSupport) as (keyof ClientSupport)[];

	for (const feat of features) {
		for (const client of clients) {
			const level = feat.support[client];
			if (level === 'full') continue;

			const clientInfo = emailClients[client];
			limitations.push({
				client: clientInfo?.name ?? client,
				clientIcon: clientIconMap[client] ?? 'unknown',
				issue: `${feat.feature}: ${feat.fallback}`,
				severity:
					feat.degradationImpact === 'functional' || feat.degradationImpact === 'hidden'
						? 'critical'
						: level === 'none'
							? 'warning'
							: 'info',
				audiencePercent: clientInfo?.marketSharePercent ?? 0,
				canIEmailUrl: feat.canIEmailSlug
					? `https://www.caniemail.com/features/${feat.canIEmailSlug}/`
					: undefined,
			});
		}
	}

	for (const prop of usedProps) {
		for (const client of clients) {
			const level = prop.support[client];
			if (level === 'full') continue;

			const clientInfo = emailClients[client];
			limitations.push({
				client: clientInfo?.name ?? client,
				clientIcon: clientIconMap[client] ?? 'unknown',
				issue: `${prop.property}: ${prop.recommendation}`,
				severity: prop.severity,
				audiencePercent: clientInfo?.marketSharePercent ?? 0,
				fix: prop.fixes?.[0],
			});
		}
	}

	limitations.sort((a, b) => b.audiencePercent - a.audiencePercent);
	return limitations;
};

/** Properties that are safe to use in every client for the given block. */
export const getSafeBlockConfig = (blockType: BlockType): readonly string[] => {
	const safe = new Set<string>();
	for (const prop of propertiesFor(blockType)) {
		const allFull = (Object.values(prop.support) as SupportLevel[]).every((s) => s === 'full');
		if (allFull) safe.add(prop.property);
	}
	return [...safe];
};

/** Returns the property's entry if it triggers any compatibility issue. */
export const checkPropertyCompatibility = (
	blockType: BlockType,
	property: string,
	_value: unknown,
): PropertyCompatibility | null => {
	const match = propertiesFor(blockType).find((p) => p.property === property);
	if (!match) return null;
	const hasIssue = (Object.values(match.support) as SupportLevel[]).some((s) => s !== 'full');
	return hasIssue ? match : null;
};
