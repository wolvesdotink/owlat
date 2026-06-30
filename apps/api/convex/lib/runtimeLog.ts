export function logError(message?: unknown, ...optionalParams: unknown[]): void {
	globalThis.console?.error(message, ...optionalParams);
}

export function logWarn(message?: unknown, ...optionalParams: unknown[]): void {
	globalThis.console?.warn(message, ...optionalParams);
}

export function logInfo(message?: unknown, ...optionalParams: unknown[]): void {
	globalThis.console?.log(message, ...optionalParams);
}
