/** One timestamped stdout line per worker event; the container runtime collects it. */
export function log(msg: string): void {
	console.info(`[code-worker] ${new Date().toISOString()} ${msg}`);
}
