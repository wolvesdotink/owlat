/**
 * Vitest setup file for Vue composable tests
 * Mocks Vue auto-imports that Nuxt provides globally
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
} from 'vue';

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
	type Ref<T> = import('vue').Ref<T>;
}
