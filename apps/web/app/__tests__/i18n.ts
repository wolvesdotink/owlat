/**
 * THE REAL MESSAGE CATALOG, NOT A `t: (key) => key` STUB.
 *
 * The extracted surfaces render every visible string through vue-i18n, so a
 * stub that echoed key paths would audit markup no user ever sees — and would
 * hide exactly the failures these suites exist to catch (a control whose
 * accessible name is now a missing key, a label bound to a message that does
 * not exist). Mounting with `i18n/locales/en.json` keeps the audited page
 * character-for-character the one the browser paints.
 */
import { expect } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import { createI18n, useI18n } from 'vue-i18n';
import en from '~~/i18n/locales/en.json';

/** A fresh i18n instance per suite — locale state must not leak between mounts. */
export function createTestI18n() {
	return createI18n({
		legacy: false,
		locale: 'en',
		fallbackLocale: 'en',
		// `de` present but empty: @nuxtjs/i18n augments createI18n to require every
		// declared locale, and these suites only ever mount the English copy.
		messages: { en, de: {} },
	});
}

/**
 * `useI18n` is an auto-import in the app, so it has to be a global here; the
 * real one resolves against whichever instance `global.plugins` installed.
 */
export const i18nStubs = { useI18n };

/** A message key that leaked into the page instead of its translation. */
const RAW_KEY_PATH =
	/\b(?:common|auth|recipient|postbox|welcome|dashboard|components|shared|desktop|setup|invite|compose|imprint|terms|home|cancelDeletion|shell|ui)(?:\.[A-Za-z][A-Za-z0-9-]*){2,}\b/;
/** An interpolation the page never filled in — `{email}` in front of a stranger. */
const UNFILLED_PLACEHOLDER = /\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}/;

/** Everything a person reads or hears: body copy, placeholders, accessible names. */
function renderedStrings(wrapper: VueWrapper): string[] {
	const strings = [wrapper.text()];
	// `wrapper.element` is `ComponentPublicInstance['$el']`, i.e. `any`; naming the
	// DOM type here is what keeps the elements below typed rather than `unknown`.
	const root: Element = wrapper.element;
	const carriers: NodeListOf<HTMLElement> = root.querySelectorAll(
		'[placeholder], [aria-label], [title]'
	);
	carriers.forEach((el: HTMLElement) => {
		for (const attr of ['placeholder', 'aria-label', 'title']) {
			const value = el.getAttribute(attr);
			if (value) strings.push(value);
		}
	});
	return strings;
}

/**
 * The two failures extraction introduces that still render "fine": a keypath
 * typo painting `auth.login.submit` as body copy, and an `<I18nT>` slot renamed
 * on one side leaving a literal `{email}` on screen. Checked over visible text,
 * placeholders and accessible names, because a control that lost its label is
 * exactly as broken as a paragraph that lost its sentence.
 */
export function expectFullyLocalized(wrapper: VueWrapper): void {
	for (const rendered of renderedStrings(wrapper)) {
		expect(rendered).not.toMatch(RAW_KEY_PATH);
		expect(rendered).not.toMatch(UNFILLED_PLACEHOLDER);
	}
}
