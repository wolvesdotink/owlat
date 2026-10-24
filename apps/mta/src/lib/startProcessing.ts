/**
 * Starts the GroupMQ processing loop, then this replica's wire reports.
 *
 * GroupMQ's `Worker.run()` returns the loop itself: its promise settles only
 * once the worker stops. Startup must not await it, or every step after it
 * (the wire report, the shutdown hooks) waits until the MTA stops serving. A
 * loop that rejects goes to `onLoopFailure`, as a failed startup step would.
 */
export function startProcessing<Reports>(deps: {
	worker: { run(): Promise<void> };
	startReports: () => Reports;
	onLoopFailure: (err: unknown) => void;
}): Reports {
	deps.worker.run().catch(deps.onLoopFailure);
	return deps.startReports();
}
