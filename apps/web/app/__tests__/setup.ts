/**
 * Vitest setup file for Vue composable tests
 * Mocks Vue auto-imports that Nuxt provides globally
 */
import { afterEach, vi } from 'vitest';
import { enableAutoUnmountOnce } from '@owlat/ui/__tests__/autoUnmount';
import { installVueWarnGuard } from './vueWarnings';
import { registerNuxtComponents } from './nuxtComponents';
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
	nextTick,
	toRef,
	toRefs,
	toValue,
	toRaw,
	unref,
	isRef,
	shallowRef,
	triggerRef,
	getCurrentInstance,
	getCurrentScope,
	onScopeDispose,
	useId,
} from 'vue';
import { useConfirm } from '~/composables/useConfirm';

registerNuxtComponents();
installVueWarnGuard();
// Every wrapper `mount` / `shallowMount` returns is unmounted after its test,
// also when an assertion or a wait in it failed, so no component, listener or
// teleported node outlives the test that made it. This is the suite's only
// registration: @vue/test-utils throws if a test file registers a second one.
// Registered after the warn guard so a warning raised while unmounting is still
// charged to the test that mounted (afterEach hooks run last-registered first).
enableAutoUnmountOnce(afterEach);

// Make Vue reactivity primitives available globally (Nuxt auto-imports these)
vi.stubGlobal('ref', ref);
vi.stubGlobal('computed', computed);
vi.stubGlobal('reactive', reactive);
vi.stubGlobal('readonly', readonly);
vi.stubGlobal('watch', watch);
vi.stubGlobal('watchEffect', watchEffect);
vi.stubGlobal('onMounted', onMounted);
vi.stubGlobal('onUnmounted', onUnmounted);
vi.stubGlobal('onBeforeUnmount', onBeforeUnmount);
vi.stubGlobal('nextTick', nextTick);
vi.stubGlobal('toRef', toRef);
vi.stubGlobal('toRefs', toRefs);
vi.stubGlobal('toValue', toValue);
vi.stubGlobal('toRaw', toRaw);
vi.stubGlobal('unref', unref);
vi.stubGlobal('isRef', isRef);
vi.stubGlobal('shallowRef', shallowRef);
vi.stubGlobal('triggerRef', triggerRef);
vi.stubGlobal('getCurrentInstance', getCurrentInstance);
vi.stubGlobal('getCurrentScope', getCurrentScope);
vi.stubGlobal('onScopeDispose', onScopeDispose);
// Nuxt auto-imports `useId` too; components that label a control by id need it.
vi.stubGlobal('useId', useId);
// A plugin module can carry named exports next to its `defineNuxtPlugin` default
// (`plugins/plugin-composition.generated.ts` exports the bundled composition the
// admin rail and palette read), so importing it must not throw outside Nuxt.
vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin);
// The app's own composable, not a stand-in: with no dialog host mounted every
// question answers no, so a suite that never looks at a confirmation cannot
// run a destructive action by accident. `~/__tests__/confirm` adds a host the
// test answers for.
vi.stubGlobal('useConfirm', useConfirm);

// Type augmentation for global scope
declare global {
	const ref: (typeof import('vue'))['ref'];
	const computed: (typeof import('vue'))['computed'];
	const reactive: (typeof import('vue'))['reactive'];
	const readonly: (typeof import('vue'))['readonly'];
	const watch: (typeof import('vue'))['watch'];
	const watchEffect: (typeof import('vue'))['watchEffect'];
	const onMounted: (typeof import('vue'))['onMounted'];
	const onUnmounted: (typeof import('vue'))['onUnmounted'];
	const onBeforeUnmount: (typeof import('vue'))['onBeforeUnmount'];
	const nextTick: (typeof import('vue'))['nextTick'];
	const toRef: (typeof import('vue'))['toRef'];
	const toRefs: (typeof import('vue'))['toRefs'];
	const toValue: (typeof import('vue'))['toValue'];
	const toRaw: (typeof import('vue'))['toRaw'];
	const unref: (typeof import('vue'))['unref'];
	const isRef: (typeof import('vue'))['isRef'];
	const shallowRef: (typeof import('vue'))['shallowRef'];
	const triggerRef: (typeof import('vue'))['triggerRef'];
	const getCurrentInstance: (typeof import('vue'))['getCurrentInstance'];
	const getCurrentScope: (typeof import('vue'))['getCurrentScope'];
	const onScopeDispose: (typeof import('vue'))['onScopeDispose'];
	const useId: (typeof import('vue'))['useId'];
	type Ref<T> = import('vue').Ref<T>;
}
