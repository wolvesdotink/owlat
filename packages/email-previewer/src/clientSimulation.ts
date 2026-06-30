// ============================================================
// Client-side render simulation
//
// Pure, non-reactive logic used by EmailPreviewer.vue to approximate how a
// given email client would render an HTML email: per-client profile tables,
// profile merging, and DOMParser-based string surgery that strips unsupported
// CSS declarations / elements / attributes and blocks remote images.
//
// These functions use browser DOM APIs (DOMParser, document) but hold no Vue
// reactivity, so they live as plain TS outside the SFC.
// ============================================================
import type { EmailClient, CompatibilityReport } from './types';

export interface SimulationProfile {
	unsupportedCssProperties: string[];
	unsupportedElements: string[];
	stripClassAttributes?: boolean;
	stripIdAttributes?: boolean;
	blockRemoteImages?: boolean;
}

export interface SimulationResult {
	html: string;
	removedCssDeclarations: number;
	removedElements: number;
	strippedAttributes: number;
	blockedImages: number;
}

const simulationProfilesByFamily: Partial<Record<EmailClient['family'], SimulationProfile>> = {
	gmail: {
		unsupportedCssProperties: ['mix-blend-mode', 'clip-path', 'object-fit', 'object-position'],
		unsupportedElements: ['video', 'audio', 'form', 'dialog', 'canvas'],
	},
	outlook: {
		unsupportedCssProperties: ['filter', 'mix-blend-mode', 'clip-path', 'object-fit', 'object-position'],
		unsupportedElements: ['video', 'audio', 'form'],
	},
	yahoo: {
		unsupportedCssProperties: ['mix-blend-mode', 'clip-path', 'filter'],
		unsupportedElements: ['video', 'audio', 'form', 'dialog'],
	},
	'samsung-email': {
		unsupportedCssProperties: ['mix-blend-mode', 'clip-path'],
		unsupportedElements: ['video', 'audio', 'form'],
	},
	protonmail: {
		unsupportedCssProperties: ['mix-blend-mode', 'clip-path', 'filter'],
		unsupportedElements: ['video', 'audio', 'form'],
		blockRemoteImages: true,
	},
	hey: {
		unsupportedCssProperties: ['mix-blend-mode'],
		unsupportedElements: ['video', 'audio', 'form'],
	},
	fastmail: {
		unsupportedCssProperties: ['mix-blend-mode'],
		unsupportedElements: ['video', 'audio', 'form'],
	},
};

const simulationProfilesByClientId: Record<string, Partial<SimulationProfile>> = {
	'gmail-webmail': {
		unsupportedCssProperties: ['animation', 'transition', 'position'],
		stripIdAttributes: true,
	},
	'gmail-ios': {
		unsupportedCssProperties: ['mix-blend-mode', 'clip-path'],
	},
	'gmail-android': {
		unsupportedCssProperties: ['mix-blend-mode', 'clip-path'],
	},
	'outlook-windows': {
		unsupportedCssProperties: [
			'display',
			'flex-direction',
			'justify-content',
			'align-items',
			'flex-wrap',
			'grid',
			'grid-template',
			'position',
			'border-radius',
			'box-shadow',
			'background-image',
			'background-size',
			'background-position',
			'animation',
			'transition',
			'transform',
		],
		unsupportedElements: ['video', 'audio', 'form', 'input', 'select', 'textarea', 'canvas', 'dialog', 'svg'],
	},
	'outlook-webmail': {
		unsupportedCssProperties: ['mix-blend-mode', 'clip-path', 'filter'],
		unsupportedElements: ['video', 'audio', 'form'],
	},
	'outlook-ios': {
		unsupportedCssProperties: ['mix-blend-mode', 'clip-path'],
		unsupportedElements: ['video', 'audio', 'form'],
	},
	'outlook-android': {
		unsupportedCssProperties: ['mix-blend-mode', 'clip-path'],
		unsupportedElements: ['video', 'audio', 'form'],
	},
	'outlook-macos': {
		unsupportedCssProperties: ['mix-blend-mode'],
		unsupportedElements: ['video', 'audio', 'form'],
	},
	'yahoo-webmail': {
		unsupportedCssProperties: ['position'],
		blockRemoteImages: true,
	},
	'protonmail-webmail': {
		blockRemoteImages: true,
	},
	'hey-webmail': {
		blockRemoteImages: true,
	},
};

const issueFeatureCssFallbackMap: Record<string, string[]> = {
	'css-display-flex': ['display', 'flex-direction', 'justify-content', 'align-items', 'flex-wrap'],
	'css-display-grid': ['display', 'grid'],
	'css-grid-template': ['grid-template'],
	'css-position': ['position'],
	'css-background-image': ['background-image', 'background-size', 'background-position'],
	'css-border-radius': ['border-radius'],
	'css-box-shadow': ['box-shadow'],
	'css-filter': ['filter'],
	'css-object-fit': ['object-fit'],
	'css-object-position': ['object-position'],
	'css-mix-blend-mode': ['mix-blend-mode'],
	'css-clip-path': ['clip-path'],
	'css-animation': ['animation'],
	'css-transition': ['transition'],
	'css-transform': ['transform'],
};

const issueFeatureElementFallbackMap: Record<string, string[]> = {
	'html-video': ['video'],
	'html-audio': ['audio'],
	'html-picture': ['picture', 'source'],
	'html-svg': ['svg'],
	'html-form': ['form'],
	'html-input-checkbox': ['input'],
	'html-button-reset': ['button'],
	'html-select': ['select'],
	'html-textarea': ['textarea'],
	'html-dialog': ['dialog'],
	'html-meter': ['meter'],
	'html-progress': ['progress'],
};

function uniq(values: string[]): string[] {
	return [...new Set(values)];
}

function mergeSimulationProfile(
	base: SimulationProfile | undefined,
	override: Partial<SimulationProfile> | undefined
): SimulationProfile | null {
	if (!base && !override) return null;
	return {
		unsupportedCssProperties: uniq([
			...(base?.unsupportedCssProperties ?? []),
			...(override?.unsupportedCssProperties ?? []),
		]),
		unsupportedElements: uniq([...(base?.unsupportedElements ?? []), ...(override?.unsupportedElements ?? [])]),
		stripClassAttributes: override?.stripClassAttributes ?? base?.stripClassAttributes ?? false,
		stripIdAttributes: override?.stripIdAttributes ?? base?.stripIdAttributes ?? false,
		blockRemoteImages: override?.blockRemoteImages ?? base?.blockRemoteImages ?? false,
	};
}

function buildReportDrivenProfile(client: EmailClient, compatibilityReport: CompatibilityReport | null): SimulationProfile | null {
	if (!compatibilityReport) return null;
	if (compatibilityReport.testedClients.length !== 1) return null;
	if (compatibilityReport.testedClients[0] !== client.name) return null;

	const unsupportedCssProperties: string[] = [];
	const unsupportedElements: string[] = [];

	for (const issue of compatibilityReport.issues) {
		if (issue.cssProperty) {
			unsupportedCssProperties.push(issue.cssProperty);
		}
		if (issue.htmlElement) {
			unsupportedElements.push(issue.htmlElement);
		}
		if (issue.feature && issue.feature in issueFeatureCssFallbackMap) {
			unsupportedCssProperties.push(...issueFeatureCssFallbackMap[issue.feature]!);
		}
		if (issue.feature && issue.feature in issueFeatureElementFallbackMap) {
			unsupportedElements.push(...issueFeatureElementFallbackMap[issue.feature]!);
		}
	}

	if (unsupportedCssProperties.length === 0 && unsupportedElements.length === 0) {
		return null;
	}

	return {
		unsupportedCssProperties: uniq(unsupportedCssProperties),
		unsupportedElements: uniq(unsupportedElements),
	};
}

function getSimulationProfile(client: EmailClient, compatibilityReport: CompatibilityReport | null): SimulationProfile | null {
	const familyProfile = simulationProfilesByFamily[client.family];
	const clientProfile = simulationProfilesByClientId[client.id];
	const reportProfile = buildReportDrivenProfile(client, compatibilityReport);

	const mergedBase = mergeSimulationProfile(familyProfile, clientProfile);
	return mergeSimulationProfile(mergedBase ?? undefined, reportProfile ?? undefined);
}

function isUnsupportedProperty(prop: string, unsupportedProperties: string[]): boolean {
	const normalizedProp = prop.toLowerCase();
	return unsupportedProperties.some(
		(candidate) =>
			normalizedProp === candidate.toLowerCase() ||
			normalizedProp.startsWith(`${candidate.toLowerCase()}-`)
	);
}

function filterInlineStyle(
	styleValue: string,
	unsupportedProperties: string[]
): { filtered: string; removedCount: number } {
	const declarations = styleValue
		.split(';')
		.map((part) => part.trim())
		.filter(Boolean);

	const kept: string[] = [];
	let removedCount = 0;

	for (const declaration of declarations) {
		const separatorIndex = declaration.indexOf(':');
		if (separatorIndex === -1) {
			kept.push(declaration);
			continue;
		}

		const prop = declaration.slice(0, separatorIndex).trim().toLowerCase();
		if (isUnsupportedProperty(prop, unsupportedProperties)) {
			removedCount++;
			continue;
		}
		kept.push(declaration);
	}

	return {
		filtered: kept.join('; '),
		removedCount,
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripUnsupportedCssFromStyleTag(
	cssText: string,
	unsupportedProperties: string[]
): { filtered: string; removedCount: number } {
	let filtered = cssText;
	let removedCount = 0;

	for (const prop of unsupportedProperties) {
		const propertyPattern = new RegExp(
			`(^|[;{\\s])(${escapeRegExp(prop)}(?:-[a-z0-9-]+)?)\\s*:[^;}{]+;?`,
			'gi'
		);
		const matches = filtered.match(propertyPattern);
		if (matches) {
			removedCount += matches.length;
		}
		filtered = filtered.replace(propertyPattern, '$1');
	}

	filtered = filtered.replace(/;\s*;/g, ';').replace(/\{\s*;/g, '{').replace(/;\s*}/g, '}');
	return { filtered, removedCount };
}

export function applyClientSimulation(
	html: string,
	client: EmailClient,
	compatibilityReport: CompatibilityReport | null
): SimulationResult {
	const profile = getSimulationProfile(client, compatibilityReport);
	if (!profile || typeof DOMParser === 'undefined') {
		return {
			html,
			removedCssDeclarations: 0,
			removedElements: 0,
			strippedAttributes: 0,
			blockedImages: 0,
		};
	}

	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');

	let removedCssDeclarations = 0;
	let removedElements = 0;
	let strippedAttributes = 0;
	let blockedImages = 0;

	for (const element of Array.from(doc.querySelectorAll<HTMLElement>('[style]'))) {
		const styleValue = element.getAttribute('style');
		if (!styleValue) continue;

		const { filtered, removedCount } = filterInlineStyle(styleValue, profile.unsupportedCssProperties);
		removedCssDeclarations += removedCount;

		if (filtered) {
			element.setAttribute('style', filtered);
		} else {
			element.removeAttribute('style');
		}
	}

	for (const styleTag of Array.from(doc.querySelectorAll('style'))) {
		const cssText = styleTag.textContent ?? '';
		if (!cssText.trim()) continue;

		const { filtered, removedCount } = stripUnsupportedCssFromStyleTag(
			cssText,
			profile.unsupportedCssProperties
		);
		removedCssDeclarations += removedCount;

		if (filtered.trim()) {
			styleTag.textContent = filtered;
		} else {
			styleTag.remove();
		}
	}

	if (profile.unsupportedElements.length > 0) {
		const unsupportedNodes = Array.from(doc.querySelectorAll(profile.unsupportedElements.join(',')));
		removedElements = unsupportedNodes.length;
		for (const node of unsupportedNodes) {
			node.remove();
		}
	}

	if (profile.stripClassAttributes) {
		const classNodes = Array.from(doc.querySelectorAll('[class]'));
		strippedAttributes += classNodes.length;
		for (const node of classNodes) {
			node.removeAttribute('class');
		}
	}

	if (profile.stripIdAttributes) {
		const idNodes = Array.from(doc.querySelectorAll('[id]'));
		strippedAttributes += idNodes.length;
		for (const node of idNodes) {
			node.removeAttribute('id');
		}
	}

	if (profile.blockRemoteImages) {
		const imageNodes = Array.from(doc.querySelectorAll<HTMLImageElement>('img[src]'));
		for (const imageNode of imageNodes) {
			const srcValue = imageNode.getAttribute('src');
			if (!srcValue) continue;
			const normalizedSrc = srcValue.trim().toLowerCase();
			if (
				normalizedSrc.startsWith('http://') ||
				normalizedSrc.startsWith('https://') ||
				normalizedSrc.startsWith('//')
			) {
				blockedImages++;
				imageNode.removeAttribute('src');
				const existingStyle = imageNode.getAttribute('style')?.trim();
				imageNode.setAttribute(
					'style',
					existingStyle ? `${existingStyle}; display:none !important;` : 'display:none !important;'
				);
			}
		}
	}

	return {
		html: doc.documentElement.outerHTML,
		removedCssDeclarations,
		removedElements,
		strippedAttributes,
		blockedImages,
	};
}
