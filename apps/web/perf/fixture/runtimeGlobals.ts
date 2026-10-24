/**
 * The runtime half of the fixture's auto-imports: Vue's and vue-i18n's
 * functions, the Convex client, and stand-ins for the parts of Nuxt's runtime
 * the mounted components reach (route, router, keyed state, runtime config and
 * the app instance). Installed on `globalThis` before any app module
 * evaluates; ./autoImports.ts adds the app's own composables after it.
 *
 * Each stand-in is the state a page with no backend is in. `useConvex`
 * returns no client. The route is a Postbox inbox with no query; navigation
 * goes nowhere; `useState` keeps one ref per key for the page's lifetime, as
 * Nuxt's payload state does; the runtime config names no deployment; the app
 * instance provides no plugins (so analytics, for one, holds no client). No
 * scenario measures them: they exist so the real components and composables
 * around them can run.
 */
import * as vue from 'vue';
import { useI18n } from 'vue-i18n';

const state = new Map<string, vue.Ref<unknown>>();

function useState<T>(key: string, init?: () => T): vue.Ref<T> {
	let entry = state.get(key);
	if (!entry) {
		entry = vue.ref(init ? init() : undefined);
		state.set(key, entry);
	}
	return entry as vue.Ref<T>;
}

const route = vue.reactive({
	path: '/dashboard/postbox/inbox',
	fullPath: '/dashboard/postbox/inbox',
	name: 'dashboard-postbox-folder',
	params: { folder: 'inbox' } as Record<string, string>,
	query: {} as Record<string, string>,
	hash: '',
	meta: {} as Record<string, unknown>,
});

const navigateTo = async (_to: unknown, _options?: unknown) => undefined;

const router = {
	currentRoute: vue.ref(route),
	push: navigateTo,
	replace: navigateTo,
	back: () => undefined,
	resolve: (to: unknown) => ({ href: typeof to === 'string' ? to : route.fullPath }),
};

const nuxtApp = { hook: () => () => undefined, hooks: { hook: () => () => undefined } };

Object.assign(globalThis, {
	ref: vue.ref,
	computed: vue.computed,
	reactive: vue.reactive,
	readonly: vue.readonly,
	watch: vue.watch,
	watchEffect: vue.watchEffect,
	onMounted: vue.onMounted,
	onUnmounted: vue.onUnmounted,
	onBeforeUnmount: vue.onBeforeUnmount,
	nextTick: vue.nextTick,
	toRef: vue.toRef,
	toRefs: vue.toRefs,
	toValue: vue.toValue,
	toRaw: vue.toRaw,
	unref: vue.unref,
	isRef: vue.isRef,
	shallowRef: vue.shallowRef,
	triggerRef: vue.triggerRef,
	getCurrentInstance: vue.getCurrentInstance,
	getCurrentScope: vue.getCurrentScope,
	onScopeDispose: vue.onScopeDispose,
	provide: vue.provide,
	inject: vue.inject,
	useId: vue.useId,
	useI18n,
	useConvex: () => null,
	useState,
	useRoute: () => route,
	useRouter: () => router,
	navigateTo,
	useRuntimeConfig: () => ({ public: {} }),
	useNuxtApp: () => nuxtApp,
});
