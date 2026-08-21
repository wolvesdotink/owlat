/**
 * Nuxt-layer auto-import polyfills for vitest (mirrors apps/web's setup —
 * see CLAUDE.md: never run these with `bun test`, it skips this file).
 */
import { vi } from 'vitest';
import {
	ref,
	computed,
	reactive,
	readonly,
	watch,
	watchEffect,
	onMounted,
	onUnmounted,
	onBeforeUnmount,
	onErrorCaptured,
	nextTick,
	shallowRef,
	unref,
	isRef,
	useId,
	useSlots,
	provide,
	inject,
} from 'vue';
import { createUiI18n } from './__tests__/i18n';

vi.stubGlobal('ref', ref);
vi.stubGlobal('computed', computed);
vi.stubGlobal('reactive', reactive);
vi.stubGlobal('readonly', readonly);
vi.stubGlobal('watch', watch);
vi.stubGlobal('watchEffect', watchEffect);
vi.stubGlobal('onMounted', onMounted);
vi.stubGlobal('onUnmounted', onUnmounted);
vi.stubGlobal('onBeforeUnmount', onBeforeUnmount);
vi.stubGlobal('onErrorCaptured', onErrorCaptured);
vi.stubGlobal('nextTick', nextTick);
vi.stubGlobal('shallowRef', shallowRef);
vi.stubGlobal('unref', unref);
vi.stubGlobal('isRef', isRef);
vi.stubGlobal('useId', useId);
vi.stubGlobal('useSlots', useSlots);
vi.stubGlobal('provide', provide);
vi.stubGlobal('inject', inject);

/**
 * @nuxtjs/color-mode's auto-import, used by ThemeToggle. The module persists
 * the preference itself in the app; a plain reactive object is enough to drive
 * the component's three-state cycle.
 */
vi.stubGlobal('useColorMode', () => reactive({ preference: 'system', value: 'light' }));

/**
 * A vue-i18n instance built from the layer's OWN catalogs
 * (`i18n/locales/en.json`, plus `de.json` for the locale-switch assertions), so
 * component tests render the real copy instead of key paths.
 *
 * Two entry points, because the layer has two:
 *  - components resolve messages through `useUiI18n()` → `useI18n()` from
 *    vue-i18n, which needs an APP-level instance: `mountUi()` in
 *    `__tests__/i18n.ts` installs a fresh one per mount;
 *  - `useI18n` is also a Nuxt auto-import in the consuming apps, so it is
 *    stubbed here as a global bound to a shared instance — that keeps a
 *    composable called outside a component (as unit tests do) on real copy too.
 */
const sharedI18n = createUiI18n('en');
vi.stubGlobal('useI18n', () => sharedI18n.global);
