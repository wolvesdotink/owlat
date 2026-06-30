/**
 * Lightweight CSS inliner for email rendering.
 *
 * Parses the generated <style> block and applies computable styles inline
 * onto matching elements. Preserves media queries, prefers-color-scheme,
 * keyframes, and animation rules in the <style> block (they can't be inlined).
 *
 * This is critical for Gmail, Yahoo, and other clients that strip <style> tags.
 */

interface CssRule {
	selector: string;
	declarations: string; // e.g. "color:red;font-size:16px"
}


/**
 * Properties that should NOT be inlined (they only make sense in a <style> block).
 */
const SKIP_INLINE_PROPS = new Set([
	'animation',
	'animation-name',
	'animation-duration',
	'animation-delay',
	'animation-timing-function',
	'animation-fill-mode',
	'transition',
]);

/**
 * Parse a CSS string into individual rules, extracting only non-at-rule blocks.
 * At-rules (@media, @keyframes, etc.) are left in the <style> block untouched.
 *
 * Supports annotation comments:
 * - `/* @inline *\/` before a rule: force-inline that rule even if it has complex selectors
 * - `/* @head-only *\/` before a rule: keep that rule in the <style> block only, never inline
 */
const parseCssRules = (css: string, headOnlyRules: string[]): CssRule[] => {
	const rules: CssRule[] = [];

	// Extract @head-only annotated rules before removing comments
	// These are kept in <style> and never inlined
	headOnlyRules.length = 0;
	const headOnlyRegex = /\/\*\s*@head-only\s*\*\/\s*([^{]+)\{([^}]+)\}/g;
	let headMatch: RegExpExecArray | null;
	while ((headMatch = headOnlyRegex.exec(css)) !== null) {
		headOnlyRules.push(headMatch[1]!.trim());
	}

	// Extract @inline annotations before removing comments
	const forceInlineSelectors = new Set<string>();
	const inlineRegex = /\/\*\s*@inline\s*\*\/\s*([^{]+)\{/g;
	let inlineMatch: RegExpExecArray | null;
	while ((inlineMatch = inlineRegex.exec(css)) !== null) {
		forceInlineSelectors.add(inlineMatch[1]!.trim());
	}

	// Remove comments
	let cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');

	// Extract and skip all @-blocks (media queries, keyframes, etc.)
	// We need to match nested braces, so use a simple depth counter
	let i = 0;
	let plainCss = '';
	while (i < cleaned.length) {
		if (cleaned[i] === '@') {
			// Skip to the matching closing brace
			let depth = 0;
			let foundOpen = false;
			while (i < cleaned.length) {
				if (cleaned[i] === '{') {
					depth++;
					foundOpen = true;
				} else if (cleaned[i] === '}') {
					depth--;
					if (foundOpen && depth === 0) {
						i++;
						break;
					}
				}
				i++;
			}
		} else {
			plainCss += cleaned[i];
			i++;
		}
	}

	// Parse remaining plain rules: selector { declarations }
	const ruleRegex = /([^{}]+)\{([^{}]+)\}/g;
	let match: RegExpExecArray | null;
	while ((match = ruleRegex.exec(plainCss)) !== null) {
		const selector = match[1]!.trim();
		const declarations = match[2]!.trim();

		// Skip @head-only annotated rules
		if (headOnlyRules.includes(selector)) {
			continue;
		}

		// Force-inline annotated rules bypass complex selector check
		const forceInline = forceInlineSelectors.has(selector);

		// Skip pseudo-selectors and complex selectors that can't be inlined (unless force-inlined)
		if (!forceInline && (selector.includes(':') || selector.includes('[') || selector.includes('>') || selector.includes('+') || selector.includes('~'))) {
			continue;
		}

		// Only inline class selectors and element selectors
		if (selector && declarations) {
			rules.push({ selector, declarations });
		}
	}

	return rules;
};

/**
 * Filter declarations to only include properties safe for inlining.
 */
const filterDeclarations = (declarations: string): string => {
	return declarations
		.split(';')
		.map((d) => d.trim())
		.filter((d) => {
			if (!d) return false;
			const prop = d.split(':')[0]?.trim().toLowerCase();
			if (!prop) return false;
			return !SKIP_INLINE_PROPS.has(prop);
		})
		.join(';');
};

/**
 * Check if an element's existing style or class/tag matches a CSS selector.
 * Supports: tag selectors (body, table, td, a, p, etc.), class selectors (.foo),
 * and compound class selectors (.foo.bar).
 */
const matchesSelector = (
	tagName: string,
	classNames: string[],
	selector: string,
): boolean => {
	const parts = selector.split(',').map((s) => s.trim());
	return parts.some((part) => {
		// Pure element selector
		if (!part.startsWith('.') && !part.includes('.')) {
			return part.toLowerCase() === tagName.toLowerCase();
		}

		// Class selector(s)
		const classParts = part.split('.').filter(Boolean);

		// If selector starts with a tag (e.g., "td.owlat-dark-bg")
		if (!part.startsWith('.')) {
			const tag = classParts[0];
			if (tag && tag.toLowerCase() !== tagName.toLowerCase()) return false;
			const requiredClasses = classParts.slice(1);
			return requiredClasses.every((c) => classNames.includes(c));
		}

		// Pure class selector(s)
		return classParts.every((c) => classNames.includes(c));
	});
};

/**
 * Inline CSS from the <style> block onto matching HTML elements.
 *
 * Strategy:
 * 1. Extract the <style> block content
 * 2. Parse non-at-rule CSS into selector -> declarations
 * 3. For each HTML element, check if any CSS selector matches
 * 4. Merge declarations into the element's existing inline style
 * 5. Leave the <style> block intact (it still contains media queries, etc.)
 */
export const inlineCss = (html: string): string => {
	// Extract style content
	const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
	if (!styleMatch) return html;

	const cssContent = styleMatch[1];
	const headOnlyRules: string[] = [];
	const rules = parseCssRules(cssContent!, headOnlyRules);
	if (rules.length === 0) return html;

	// Process each HTML element that could receive inlined styles
	// Match opening tags: <tagName ...attributes...>
	const result = html.replace(
		/<((?:table|tr|td|th|div|p|span|a|img|h[1-6]|body|center))\b([^>]*)>/gi,
		(fullMatch, tagName: string, attrs: string) => {
			// Extract existing class and style
			const classMatch = attrs.match(/class="([^"]*)"/);
			const styleMatch = attrs.match(/style="([^"]*)"/);
			const classNames = classMatch ? classMatch[1]!.split(/\s+/).filter(Boolean) : [];
			const existingStyle = styleMatch ? styleMatch[1]! : '';

			// Find matching rules
			const matchingDeclarations: string[] = [];
			for (const rule of rules) {
				if (matchesSelector(tagName, classNames, rule.selector)) {
					const filtered = filterDeclarations(rule.declarations);
					if (filtered) {
						matchingDeclarations.push(filtered);
					}
				}
			}

			if (matchingDeclarations.length === 0) return fullMatch;

			// Merge: CSS rule declarations come first (lower priority),
			// existing inline styles override (higher priority)
			const newDeclarations = matchingDeclarations.join(';');

			// Build merged style: new declarations, then existing (existing wins on conflict)
			const existingProps = new Set<string>();
			if (existingStyle) {
				for (const decl of existingStyle.split(';')) {
					const prop = decl.split(':')[0]?.trim().toLowerCase();
					if (prop) existingProps.add(prop);
				}
			}

			// Filter out declarations that are already set inline
			const filteredNew = newDeclarations
				.split(';')
				.filter((d) => {
					const prop = d.split(':')[0]?.trim().toLowerCase();
					return prop && !existingProps.has(prop);
				})
				.join(';');

			if (!filteredNew) return fullMatch;

			const mergedStyle = existingStyle
				? `${filteredNew};${existingStyle}`
				: filteredNew;

			if (styleMatch) {
				// Replace existing style attribute
				const newAttrs = attrs.replace(/style="[^"]*"/, `style="${mergedStyle}"`);
				return `<${tagName}${newAttrs}>`;
			} else {
				// Add new style attribute
				return `<${tagName}${attrs} style="${mergedStyle}">`;
			}
		},
	);

	return result;
};
