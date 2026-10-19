/**
 * Nuxt's auto-imports, as globals, for the components the scenarios mount.
 *
 * The SFCs call `ref`, `useI18n`, `useChatAttachmentDetails` and the rest
 * without importing them; Nuxt rewrites those names at build time. This
 * fixture is a plain Vite build, so it installs the same functions on
 * `globalThis` (as app/__tests__/setup.ts does for the unit suites). The app's
 * own composables are the real modules, loaded through `import.meta.glob` so
 * the fixture's typecheck does not have to model Nuxt's global scope.
 *
 * `useConvex` returns no client, the state the app is in before the Convex
 * client exists: the real `useConvexQuery` then never opens a subscription. The
 * synthetic rows carry no attachments, so the only query the mounted rows make
 * is skipped, exactly as it is for the same rows in the app.
 *
 * Must be the fixture's first import: component setup reads these globals.
 */
import * as vue from 'vue';
import { useI18n } from 'vue-i18n';

type Module = Record<string, unknown>;

const composables = import.meta.glob<Module>(
	['../../app/composables/useConvexQuery.ts', '../../app/composables/chat/useChatAttachments.ts'],
	{ eager: true }
);

function exportOf(path: string, name: string): unknown {
	const value = composables[path]?.[name];
	if (typeof value !== 'function') throw new Error(`${path} no longer exports ${name}`);
	return value;
}

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
	useId: vue.useId,
	useI18n,
	useConvex: () => null,
	useConvexQuery: exportOf('../../app/composables/useConvexQuery.ts', 'useConvexQuery'),
	useChatAttachmentDetails: exportOf(
		'../../app/composables/chat/useChatAttachments.ts',
		'useChatAttachmentDetails'
	),
});
