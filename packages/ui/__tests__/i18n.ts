/**
 * THE REAL LAYER CATALOG, NOT A `t: (key) => key` STUB.
 *
 * `packages/ui` owns the copy its components render (`ui.*`), so a component
 * test that mounted against a stub would assert on markup no user ever sees.
 * Every mount here installs a vue-i18n instance built from
 * `i18n/locales/{en,de}.json` — the very files the layer contributes to the
 * apps through `nuxt.config.ts` — so the audited component is character-for-
 * character the one the browser paints.
 */
import { createI18n } from 'vue-i18n';
import { createApp, h, type Component, type Plugin } from 'vue';
import de from '../i18n/locales/de.json';
import en from '../i18n/locales/en.json';

export type UiLocale = 'en' | 'de';

/** A fresh instance per mount — locale state must not leak between tests. */
export function createUiI18n(locale: UiLocale = 'en') {
	return createI18n({
		legacy: false,
		locale,
		fallbackLocale: 'en',
		messages: { en: structuredClone(en), de: structuredClone(de) },
	});
}

/**
 * What an APP's component test looks like: a vue-i18n instance built from that
 * app's own catalog, with no `ui.*` messages in it. The layer has to stay
 * readable there (see useUiI18n).
 */
export function createForeignI18n() {
	return createI18n({
		legacy: false,
		locale: 'en',
		fallbackLocale: 'en',
		// `de` present but empty: an app that has adopted i18n declares every
		// locale, and the augmented createI18n overloads require all of them.
		messages: { en: { app: { unrelated: 'unrelated' } }, de: {} },
	});
}

export interface MountedUi {
	el: HTMLElement;
	/** Unmounts the app and removes its host element; later calls do nothing. */
	unmount: () => void;
}

/** Apps `mountUi()` made that are still mounted; drained by `unmountAllUi()`. */
const liveMounts = new Set<MountedUi>();

/**
 * Unmount everything `mountUi()` mounted and the test did not unmount itself.
 * The vitest setup runs it after every test, so a failed assertion cannot leave
 * an app, its listeners or its host element behind for the next test.
 */
export function unmountAllUi(): void {
	for (const mounted of liveMounts) mounted.unmount();
}

/**
 * Mount a layer component against the real catalogs. Deliberately plain
 * `createApp` rather than a test-utils wrapper: the layer's own dependency
 * surface stays `vue` + `vue-i18n`, which is exactly what the apps install.
 */
export function mountUi(
	component: Component,
	props: Record<string, unknown> = {},
	locale: UiLocale = 'en',
	/**
	 * The i18n plugin to install. `null` mounts with NO vue-i18n at all — the
	 * shape of an app that extends this layer without @nuxtjs/i18n.
	 */
	i18n: Plugin | null | undefined = undefined
): MountedUi {
	const el = document.createElement('div');
	document.body.appendChild(el);
	const app = createApp(component, props);
	const plugin = i18n === undefined ? createUiI18n(locale) : i18n;
	if (plugin) app.use(plugin);
	app.mount(el);
	const mounted: MountedUi = {
		el,
		unmount: () => {
			if (!liveMounts.delete(mounted)) return;
			app.unmount();
			el.remove();
		},
	};
	liveMounts.add(mounted);
	return mounted;
}
