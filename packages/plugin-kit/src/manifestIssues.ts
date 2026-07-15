export type PluginManifestIssueCode =
	| 'accessor_not_allowed'
	| 'duplicate'
	| 'invalid_format'
	| 'invalid_type'
	| 'missing'
	| 'too_many_items'
	| 'unknown_field';

export interface PluginManifestIssue {
	readonly code: PluginManifestIssueCode;
	readonly path: string;
	readonly message: string;
}

export function addManifestIssue(
	issues: PluginManifestIssue[],
	code: PluginManifestIssueCode,
	path: string,
	message: string
): void {
	issues.push({ code, path, message });
}
