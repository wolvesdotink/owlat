/**
 * Homoglyph / Unicode Spoofing Detection
 *
 * Detects mixed-script content and confusable characters in URLs and link text.
 * These techniques are commonly used in sophisticated phishing attacks where
 * Latin characters are replaced with visually identical Cyrillic, Greek, or
 * other Unicode characters to spoof domain names.
 *
 * Examples:
 * - Cyrillic 'а' (U+0430) vs Latin 'a' (U+0061)
 * - Cyrillic 'о' (U+043E) vs Latin 'o' (U+006F)
 * - Greek 'ο' (U+03BF) vs Latin 'o' (U+006F)
 */

import type { ContentFlag } from '../types.js';
import { registerContentRule } from './rule.js';

// ============ UNICODE SCRIPT RANGES ============

interface ScriptRange {
	name: string;
	ranges: Array<[number, number]>;
}

const SCRIPT_RANGES: ScriptRange[] = [
	{
		name: 'Cyrillic',
		ranges: [
			[0x0400, 0x04ff], // Cyrillic
			[0x0500, 0x052f], // Cyrillic Supplement
			[0x2de0, 0x2dff], // Cyrillic Extended-A
			[0xa640, 0xa69f], // Cyrillic Extended-B
		],
	},
	{
		name: 'Greek',
		ranges: [
			[0x0370, 0x03ff], // Greek and Coptic
			[0x1f00, 0x1fff], // Greek Extended
		],
	},
	{
		name: 'Armenian',
		ranges: [
			[0x0530, 0x058f], // Armenian
		],
	},
	{
		name: 'Georgian',
		ranges: [
			[0x10a0, 0x10ff], // Georgian
		],
	},
];

// ============ CONFUSABLE CHARACTER MAP ============

/**
 * Map of Unicode characters that are visually confusable with Latin characters.
 * Key: confusable codepoint, Value: the Latin character it mimics.
 */
const CONFUSABLE_MAP: Map<number, string> = new Map([
	// Cyrillic → Latin lookalikes
	[0x0430, 'a'], // а → a
	[0x0441, 'c'], // с → c
	[0x0435, 'e'], // е → e
	[0x04bb, 'h'], // һ → h
	[0x0456, 'i'], // і → i
	[0x0458, 'j'], // ј → j
	[0x043a, 'k'], // к → k (lowercase)
	[0x043e, 'o'], // о → o
	[0x0440, 'p'], // р → p
	[0x0455, 's'], // ѕ → s
	[0x0443, 'y'], // у → y (visually closer to 'y' in most sans-serif fonts)
	[0x0445, 'x'], // х → x
	[0x0410, 'A'], // А → A
	[0x0412, 'B'], // В → B
	[0x0421, 'C'], // С → C
	[0x0415, 'E'], // Е → E
	[0x041d, 'H'], // Н → H
	[0x0406, 'I'], // І → I
	[0x041a, 'K'], // К → K
	[0x041c, 'M'], // М → M
	[0x041e, 'O'], // О → O
	[0x0420, 'P'], // Р → P
	[0x0405, 'S'], // Ѕ → S
	[0x0422, 'T'], // Т → T
	[0x0425, 'X'], // Х → X

	// Greek → Latin lookalikes
	[0x03bf, 'o'], // ο → o
	[0x03b1, 'a'], // α → a (close enough in many fonts)
	[0x03b5, 'e'], // ε → e (similar)
	[0x03b9, 'i'], // ι → i
	[0x03ba, 'k'], // κ → k
	[0x03bd, 'v'], // ν → v
	[0x03c1, 'p'], // ρ → p
	[0x03c4, 't'], // τ → t (similar in sans-serif)
	[0x03c5, 'u'], // υ → u
	[0x039f, 'O'], // Ο → O
	[0x0391, 'A'], // Α → A
	[0x0392, 'B'], // Β → B
	[0x0395, 'E'], // Ε → E
	[0x0397, 'H'], // Η → H
	[0x0399, 'I'], // Ι → I
	[0x039a, 'K'], // Κ → K
	[0x039c, 'M'], // Μ → M
	[0x039d, 'N'], // Ν → N
	[0x03a1, 'P'], // Ρ → P
	[0x03a4, 'T'], // Τ → T
	[0x03a5, 'Y'], // Υ → Y
	[0x0396, 'Z'], // Ζ → Z
]);

// ============ DETECTION FUNCTIONS ============

/**
 * Detect which non-Latin scripts are present in a string.
 *
 * Exported so sibling rules (e.g. sender-impersonation, which inspects the
 * From/Reply-To domains the URL scanner never sees) can reuse the same
 * script-range table instead of re-deriving it.
 */
export function detectScripts(text: string): Set<string> {
	const scripts = new Set<string>();

	for (let i = 0; i < text.length; i++) {
		const codePoint = text.codePointAt(i);
		if (codePoint === undefined) continue;

		// Skip ASCII and common punctuation/symbols
		if (codePoint < 0x0100) continue;

		for (const script of SCRIPT_RANGES) {
			for (const [start, end] of script.ranges) {
				if (codePoint >= start && codePoint <= end) {
					scripts.add(script.name);
					break;
				}
			}
		}

		// Handle surrogate pairs
		if (codePoint > 0xffff) i++;
	}

	return scripts;
}

/**
 * Check if a string contains Latin characters. Exported for reuse by the
 * sender-impersonation rule's mixed-script domain check.
 */
export function hasLatinChars(text: string): boolean {
	return /[a-zA-Z]/.test(text);
}

/**
 * Find confusable characters in a string and return them with their Latin equivalents.
 */
function findConfusables(
	text: string
): Array<{ char: string; codePoint: number; mimics: string; position: number }> {
	const found: Array<{ char: string; codePoint: number; mimics: string; position: number }> = [];

	for (let i = 0; i < text.length; i++) {
		const codePoint = text.codePointAt(i);
		if (codePoint === undefined) continue;

		const mimic = CONFUSABLE_MAP.get(codePoint);
		if (mimic) {
			found.push({
				char: String.fromCodePoint(codePoint),
				codePoint,
				mimics: mimic,
				position: i,
			});
		}

		// Handle surrogate pairs
		if (codePoint > 0xffff) i++;
	}

	return found;
}

/**
 * Convert a string by replacing confusable characters with their Latin equivalents.
 * This reveals what the text "looks like" to a human reader.
 */
export function deconfuse(text: string): string {
	let result = '';
	for (let i = 0; i < text.length; i++) {
		const codePoint = text.codePointAt(i);
		if (codePoint === undefined) {
			result += text[i];
			continue;
		}

		const mimic = CONFUSABLE_MAP.get(codePoint);
		if (mimic) {
			result += mimic;
		} else {
			result += String.fromCodePoint(codePoint);
		}

		// Handle surrogate pairs
		if (codePoint > 0xffff) i++;
	}
	return result;
}

// ============ MAIN SCANNER ============

/**
 * Extract the raw hostname from a URL string WITHOUT punycode conversion.
 * The standard `new URL()` constructor converts Unicode hostnames to punycode,
 * which destroys the confusable characters we need to detect.
 */
function extractRawHostname(href: string): string | undefined {
	// Match scheme://hostname pattern, capturing the hostname
	const match = /^https?:\/\/([^/:?#]+)/i.exec(href);
	if (!match) return undefined;
	return match[1];
}

/**
 * Scan URLs and link text for homoglyph spoofing and mixed-script content.
 *
 * @param urls - Array of extracted URLs with their display text
 * @returns Array of content flags for detected spoofing attempts
 */
export function scanHomoglyphs(urls: Array<{ href: string; text: string }>): ContentFlag[] {
	const flags: ContentFlag[] = [];

	for (const { href, text } of urls) {
		// Extract domain from raw href string (NOT via new URL() which converts to punycode)
		const domain = extractRawHostname(href);
		if (!domain) continue;

		// Check domain for confusable characters
		if (domain) {
			const domainConfusables = findConfusables(domain);
			if (domainConfusables.length > 0) {
				const deconfused = deconfuse(domain);
				flags.push({
					type: 'homoglyph_spoofing',
					severity: 'high',
					description: `Domain "${domain}" contains confusable Unicode characters — appears as "${deconfused}" to humans`,
					match: href,
				});
			}

			// Check for mixed scripts in domain (e.g., Cyrillic + Latin)
			const domainScripts = detectScripts(domain);
			if (domainScripts.size > 0 && hasLatinChars(domain)) {
				const scriptNames = Array.from(domainScripts).join(', ');
				// Only flag if not already flagged for confusables
				if (domainConfusables.length === 0) {
					flags.push({
						type: 'homoglyph_spoofing',
						severity: 'high',
						description: `Domain "${domain}" uses mixed scripts (Latin + ${scriptNames}) — possible IDN homograph attack`,
						match: href,
					});
				}
			}
		}

		// Check link display text for confusable characters that make it look like a trusted domain
		if (text && text.includes('.')) {
			const textConfusables = findConfusables(text);
			if (textConfusables.length > 0) {
				const deconfused = deconfuse(text);
				flags.push({
					type: 'homoglyph_spoofing',
					severity: 'high',
					description: `Link text "${text}" contains confusable Unicode characters — appears as "${deconfused}"`,
					match: text,
				});
			}
		}
	}

	return flags;
}

registerContentRule({
	id: 'homoglyphs',
	scan: ({ urls }) => scanHomoglyphs(urls),
});
