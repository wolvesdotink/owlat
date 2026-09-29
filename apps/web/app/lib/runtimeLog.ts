export function logError(message?: unknown, ...optionalParams: unknown[]): void {
	globalThis.console?.error(message, ...optionalParams);
}

export function logWarn(message?: unknown, ...optionalParams: unknown[]): void {
	globalThis.console?.warn(message, ...optionalParams);
}

/**
 * Whether this is a development build, for warnings that only help while
 * developing. A function rather than a bare `import.meta.dev` so a spec can
 * mock it: vitest leaves `import.meta.dev` undefined.
 */
export function isDevBuild(): boolean {
	return import.meta.dev === true;
}
