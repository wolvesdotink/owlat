/**
 * The app modules ./autoImports.ts installs as globals, loaded eagerly.
 *
 * A module of its own so it evaluates after ./runtimeGlobals.ts: Vite hoists a
 * glob's imports to the top of the file that holds it, ahead of that file's
 * other imports.
 */
type Module = Record<string, unknown>;

export const appModules = import.meta.glob<Module>(
	[
		'../../app/composables/{useConvexQuery,useBackendOperation,useToast,useAnnounce,usePostHog,useAuth,useOrganization,useOrganizationContext,useActiveMemberRole,usePermissions,useFeatureFlag,useFeatureCopy,useDesktopContext,useFormat}.ts',
		'../../app/composables/chat/useChatAttachments.ts',
		'../../app/composables/postbox/{usePostboxBulkActions,usePostboxOptimisticFlags,usePostboxOptimisticHide,usePostboxRowTriage,usePostboxRowPickers,usePostboxMessageDrag,usePostboxTriageUndo,usePostboxListKeyboard,usePostboxPrefetch,usePostboxSettings,usePostboxLabels,usePostboxFolders,usePostboxOfflineFolders,usePostboxOfflineCache}.ts',
		'../../app/utils/{postboxShortcuts,waitForLoaded,formatters,postboxOfflineFolderStore,postboxOfflineStore,composerDraftStore}.ts',
	],
	{ eager: true }
);
