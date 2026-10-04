import { hashPassword } from '@owlat/shared/passwordHash';
import type { TestUser } from './fixtures/test-data';

/**
 * `POST /seed/admin`, sent with Node's own `fetch` and never with Playwright's
 * `request` fixture.
 *
 * The call carries the instance secret in `X-Instance-Secret`, and that secret
 * can reset the test deployment. Playwright records every request its own
 * `APIRequestContext` makes, headers included, into the test's trace, and the
 * E2E workflow uploads traces inside the public HTML report. A request made
 * outside Playwright never reaches the trace. The workflow still scans the
 * report for the secret before uploading it (`scanReportSecrets.ts`).
 *
 * Errors name the status and the response body, never the request headers.
 */
export async function seedAdmin(options: {
	siteUrl: string;
	instanceSecret: string;
	owner: TestUser;
	fetchImpl?: typeof fetch;
}): Promise<void> {
	const { siteUrl, instanceSecret, owner, fetchImpl = fetch } = options;
	const response = await fetchImpl(`${siteUrl}/seed/admin`, {
		method: 'POST',
		headers: { 'X-Instance-Secret': instanceSecret, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			email: owner.email,
			name: owner.name,
			// Same scrypt parameters the setup CLI uses; the endpoint stores the
			// hash verbatim, so anything else is unreadable to BetterAuth.
			passwordHash: await hashPassword(owner.password),
		}),
	});

	// 409 = already bootstrapped. Signing in still proves the account works, and
	// failing here would turn "the reset did not run" into a confusing seed error
	// instead of the login error that names it.
	if (!response.ok && response.status !== 409) {
		throw new Error(
			`POST /seed/admin returned ${response.status}: ${await response.text()}. The deployment ` +
				'must be reset (POST /dev/reset) before the suite runs.'
		);
	}
}
