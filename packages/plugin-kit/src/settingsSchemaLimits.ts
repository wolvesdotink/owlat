/**
 * Domain bounds on a settings schema's size, shared by the manifest-time
 * validators (`settingsSchemaManifest`, `fieldDescriptorManifest`) and the
 * pre-validation snapshotter (`manifestSnapshot`) so the layers can never drift
 * out of sync. A leaf: `manifestSnapshot` sits below `manifestValue`, which
 * `settingsSchema` imports, so the snapshotter cannot take these from there.
 */
export const MAX_SETTINGS_FIELDS = 64;
export const MAX_SETTINGS_OPTIONS = 64;
