/** Resolve after `ms` milliseconds on the global timer, so fake timers still apply. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
