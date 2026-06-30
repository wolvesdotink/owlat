export function logError(message?: unknown, ...optionalParams: unknown[]): void {
	globalThis.console?.error(message, ...optionalParams);
}

export function logWarn(message?: unknown, ...optionalParams: unknown[]): void {
	globalThis.console?.warn(message, ...optionalParams);
}
