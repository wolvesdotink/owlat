import { getCurrentInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import en from '../i18n/locales/en.json';

/**
 * The layer's translator for its OWN copy (`ui.*` keys only).
 *
 * The catalogs live in `i18n/locales/{en,de}.json` and are contributed to every
 * consuming app by the `i18n` key in `nuxt.config.ts`, so in an app that has
 * @nuxtjs/i18n installed this is the app's global vue-i18n composer and a
 * `ui.*` message follows the app's active locale.
 *
 * It degrades to the bundled English catalog — the exact copy these components
 * hardcoded before extraction — in the two cases a shared layer cannot rule
 * out, because a layer cannot impose a module on the apps that extend it:
 *
 *  1. no vue-i18n instance at all (an app that extends `packages/ui` before it
 *     wires up @nuxtjs/i18n, or a composable exercised outside a component in a
 *     unit test). `useI18n()` throws there, and a shared Modal / ErrorBoundary /
 *     Toast must not take the app down with it;
 *  2. an instance whose messages do not include `ui.*` — which is what an app's
 *     component test looks like when it installs a vue-i18n built from that
 *     app's own catalog. Rendering `ui.modal.close` as a button's accessible
 *     name there would be a worse failure than rendering English.
 *
 * The cost is that a BROKEN layer hookup in a German app reads as untranslated
 * copy rather than visible key paths, so verify the wiring on the German copy
 * itself (e.g. the modal close button is "Dialog schließen", not "Close dialog")
 * rather than by hunting for `ui.` strings on screen.
 */

type MessageParams = Record<string, string | number>;

export interface UiTranslator {
	/** Translate a `ui.*` key, interpolating `{named}` placeholders. */
	t: (key: string, params?: MessageParams) => string;
}

/** The subset of vue-i18n's Composer this layer uses. */
interface MessageResolver {
	t: (key: string, named?: MessageParams) => string;
	te?: (key: string) => boolean;
}

type MessageTree = { [key: string]: string | MessageTree };

const bundledEnglish = en as MessageTree;

function lookup(key: string): string | undefined {
	let node: string | MessageTree | undefined = bundledEnglish;
	for (const segment of key.split('.')) {
		if (typeof node !== 'object' || node === null) return undefined;
		node = node[segment];
	}
	return typeof node === 'string' ? node : undefined;
}

function interpolate(message: string, params?: MessageParams): string {
	if (!params) return message;
	return message.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match
	);
}

function translateBundled(key: string, params?: MessageParams): string {
	return interpolate(lookup(key) ?? key, params);
}

/**
 * The app's composer, or `null` when there is no vue-i18n instance to resolve
 * against. `useI18n()` may only be called synchronously from a setup context,
 * hence the `getCurrentInstance()` guard before it.
 */
function tryUseComposer(): MessageResolver | null {
	if (!getCurrentInstance()) return null;
	try {
		return useI18n() as unknown as MessageResolver;
	} catch {
		return null;
	}
}

export function useUiI18n(): UiTranslator {
	const composer = tryUseComposer();
	if (!composer) return { t: translateBundled };

	return {
		t: (key, params) => {
			// `te` is checked per call, not once: with lazy-loaded locale files the
			// answer changes as the app's messages arrive, and `t()` is evaluated
			// inside the components' computeds.
			const known = typeof composer.te === 'function' ? composer.te(key) : true;
			if (!known) return translateBundled(key, params);
			return params ? composer.t(key, params) : composer.t(key);
		},
	};
}
