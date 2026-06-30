import { requireInstanceSecret } from '~~/server/utils/updater';

/**
 * Aggregated health check endpoint for control plane monitoring.
 *
 * This endpoint checks all local services (Convex, MTA) from within the VPS,
 * avoiding the need for the control plane to reach internal ports directly.
 * Protected by X-Instance-Secret header.
 */
export default defineEventHandler(async (event) => {
	requireInstanceSecret(event, 'Health check not configured');

	let convex = false;
	let mta = false;

	// Check Convex backend (localhost:3210)
	try {
		const convexRes = await fetch('http://localhost:3210/version', {
			signal: AbortSignal.timeout(5000),
		});
		convex = convexRes.ok;
	} catch {
		// unreachable
	}

	// Check MTA (localhost:3100)
	try {
		const mtaRes = await fetch('http://localhost:3100/health', {
			signal: AbortSignal.timeout(5000),
		});
		mta = mtaRes.ok;
	} catch {
		// unreachable
	}

	// Web is implicitly healthy if this endpoint responds
	return {
		convex,
		web: true,
		mta,
	};
});
