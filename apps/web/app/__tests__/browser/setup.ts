/**
 * Setup for the real-browser component tests (vitest.browser.config.ts).
 *
 * The same ground rules as the happy-dom suite (app/__tests__/setup.ts): Nuxt's
 * auto-imported Vue functions as globals, the components Nuxt registers for
 * every page, the real English catalog behind `useI18n`, unresolved components
 * failing the test, and every mounted wrapper unmounted after its test. On top,
 * the app's own stylesheet, because layout is what these tests measure.
 */
import { afterEach, beforeEach, vi } from 'vitest';
import { commands } from 'vitest/browser';
import { config } from '@vue/test-utils';
import * as vue from 'vue';
import { useI18n } from 'vue-i18n';
import { enableAutoUnmountOnce } from '@owlat/ui/__tests__/autoUnmount';
import { createTestI18n } from '../i18n';
import { registerNuxtComponents } from '../nuxtComponents';
import { installVueWarnGuard } from '../vueWarnings';
import '~/assets/css/main.css';

declare module 'vitest/browser' {
	interface BrowserCommands {
		/** Defined in vitest.browser.config.ts: moves Playwright's mouse off the page. */
		resetPointer: () => Promise<void>;
	}
}

const VUE_AUTO_IMPORTS = [
	'ref',
	'computed',
	'reactive',
	'readonly',
	'watch',
	'watchEffect',
	'onMounted',
	'onUnmounted',
	'onBeforeUnmount',
	'nextTick',
	'toRef',
	'toRefs',
	'toValue',
	'toRaw',
	'unref',
	'isRef',
	'shallowRef',
	'triggerRef',
	'getCurrentInstance',
	'getCurrentScope',
	'onScopeDispose',
	'useId',
] as const;
for (const name of VUE_AUTO_IMPORTS) vi.stubGlobal(name, vue[name]);
vi.stubGlobal('useI18n', useI18n);
config.global.plugins = [...config.global.plugins, createTestI18n()];

registerNuxtComponents();
installVueWarnGuard();
// Registered after the warn guard, as in the unit setup: afterEach hooks run
// last-registered first, so a warning raised while unmounting still counts.
enableAutoUnmountOnce(afterEach);

// Before each test, not after: a test that timed out keeps running and can
// move the mouse after its own afterEach.
beforeEach(async () => {
	await commands.resetPointer();
});
