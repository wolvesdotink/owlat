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
 * client exists: the real `useConvexQuery` then never opens a subscription and
 * the real `useBackendOperation` never sends anything. The synthetic rows carry
 * no attachments, so the only query the mounted chat rows make is skipped,
 * exactly as it is for the same rows in the app. Vue's and Nuxt's own runtime
 * (route, router, keyed state, config) come from ./runtimeGlobals.ts, installed
 * before any app module evaluates.
 *
 * A component that starts using an auto-import missing here fails its scenario
 * with a ReferenceError, which voids the run (perf/fixtureApi.ts): add the
 * module and the name to {@link APP_AUTO_IMPORTS}.
 *
 * Must be the fixture's first import: component setup reads these globals.
 */
import './runtimeGlobals';
import { appModules } from './appModules';

/**
 * The app's auto-imported functions the mounted components reach, by module.
 * Paths are relative to apps/web/app; the module is the real one.
 */
const APP_AUTO_IMPORTS: Record<string, readonly string[]> = {
	'composables/useConvexQuery.ts': ['useConvexQuery'],
	'composables/useBackendOperation.ts': ['useBackendOperation'],
	'composables/chat/useChatAttachments.ts': ['useChatAttachmentDetails'],
	'composables/useToast.ts': ['useToast'],
	'composables/useAnnounce.ts': ['useAnnounce'],
	'composables/usePostHog.ts': ['usePostHog'],
	'composables/useAuth.ts': ['useAuth'],
	'composables/useOrganization.ts': ['useOrganization'],
	'composables/useOrganizationContext.ts': ['useOrganizationContext'],
	'composables/useActiveMemberRole.ts': ['useActiveMemberRole'],
	'composables/usePermissions.ts': ['usePermissions'],
	'composables/useFeatureFlag.ts': ['useFeatureFlag'],
	'composables/useFeatureCopy.ts': ['useFeatureCopy'],
	'composables/useDesktopContext.ts': ['useDesktopContext'],
	'composables/useFormat.ts': ['useFormat'],
	'composables/postbox/usePostboxBulkActions.ts': ['usePostboxBulkActions'],
	'composables/postbox/usePostboxOptimisticFlags.ts': ['usePostboxOptimisticFlags'],
	'composables/postbox/usePostboxOptimisticHide.ts': ['usePostboxOptimisticHide'],
	'composables/postbox/usePostboxRowTriage.ts': ['usePostboxRowTriage'],
	'composables/postbox/usePostboxRowPickers.ts': ['usePostboxRowPickers'],
	'composables/postbox/usePostboxMessageDrag.ts': ['usePostboxListRowDrag'],
	'composables/postbox/usePostboxTriageUndo.ts': ['usePostboxTriageUndo'],
	'composables/postbox/usePostboxListKeyboard.ts': ['usePostboxListKeyboard'],
	'composables/postbox/usePostboxPrefetch.ts': ['usePostboxPrefetch'],
	'composables/postbox/usePostboxSettings.ts': ['usePostboxSettings'],
	'composables/postbox/usePostboxLabels.ts': ['usePostboxLabels'],
	'composables/postbox/usePostboxFolders.ts': ['usePostboxFolders'],
	'composables/postbox/usePostboxOfflineFolders.ts': ['usePostboxOfflineFolders'],
	'composables/postbox/usePostboxOfflineCache.ts': ['usePostboxOfflineCache'],
	'utils/postboxShortcuts.ts': ['nextUnreadIndex', 'resolvePostboxShortcut'],
	'utils/waitForLoaded.ts': ['waitForLoaded'],
	'utils/formatters.ts': ['capitalize', 'formatCompactRelativeTime'],
	'utils/postboxOfflineFolderStore.ts': ['PostboxOfflineFolderStore'],
	'utils/postboxOfflineStore.ts': ['OfflineWriteError', 'PostboxOfflineStore'],
	'utils/composerDraftStore.ts': ['ComposerDraftStore'],
};

function appAutoImports(): Record<string, unknown> {
	const installed: Record<string, unknown> = {};
	for (const [path, names] of Object.entries(APP_AUTO_IMPORTS)) {
		const module = appModules[`../../app/${path}`];
		if (!module) throw new Error(`app/${path} is not in the fixture's module glob`);
		for (const name of names) {
			const value = module[name];
			if (value === undefined) throw new Error(`app/${path} no longer exports ${name}`);
			installed[name] = value;
		}
	}
	return installed;
}

const installed = appAutoImports();
Object.assign(globalThis, installed);

/**
 * An installed auto-import for fixture code, typed by the caller: the app
 * module itself leans on Nuxt's globals, which the fixture's typecheck does
 * not model.
 */
export function autoImported<T>(name: string): T {
	if (!(name in installed)) throw new Error(`${name} is not one of the fixture's auto-imports`);
	return installed[name] as T;
}

// The feature-flag subscription is an app-wide singleton the app opens before
// any page mounts (the feature route middleware asks first). Opened here for the
// same reason: opened inside a scenario's first component instead, the
// subscription's "no Convex client" error would carry that component in its
// captured stack and keep its torn-down DOM alive for the page's lifetime.
autoImported<() => unknown>('useFeatureFlag')();
