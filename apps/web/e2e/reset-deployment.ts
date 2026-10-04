/**
 * CI step around `resetDeployment` (see .github/workflows/e2e.yml).
 *
 *   bun e2e/reset-deployment.ts
 *
 * Reads CONVEX_TEST_SITE_URL and CONVEX_TEST_INSTANCE_SECRET from the
 * environment, resets the test deployment, prints what was deleted and exits 0.
 * Transient failures are retried (resetDeployment.ts) and announced as
 * warnings. Exits 1 once a failure is definitive or the retries run out, so a
 * run whose sessions could not be ended fails.
 */
import { resetDeployment } from './resetDeployment';

const siteUrl = process.env['CONVEX_TEST_SITE_URL'] ?? '';
const instanceSecret = process.env['CONVEX_TEST_INSTANCE_SECRET'] ?? '';
if (!siteUrl || !instanceSecret) {
	console.error('::error::CONVEX_TEST_SITE_URL and CONVEX_TEST_INSTANCE_SECRET must both be set.');
	process.exit(1);
}

try {
	const { deleted } = await resetDeployment({
		siteUrl,
		instanceSecret,
		log: (line) => console.warn(`::warning::${line}`),
	});
	console.info(`Test deployment reset; deleted: ${JSON.stringify(deleted)}`);
} catch (error) {
	console.error(`::error::${error instanceof Error ? error.message : 'POST /dev/reset failed.'}`);
	process.exit(1);
}
