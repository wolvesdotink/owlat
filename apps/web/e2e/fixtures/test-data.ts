export interface TestUser {
	name: string;
	email: string;
	password: string;
}

/**
 * The instance owner the run works as.
 *
 * It is SEEDED, not registered: `/auth/register` only renders a form behind an
 * `?redirect=/invite/accept…` invite link, and the backend refuses any signup
 * once an account exists (convex/auth/registrationGate.ts). A real instance is
 * bootstrapped through `POST /seed/admin` — the same call `owlat bootstrap-org`
 * makes — so that is what the setup project does, and every spec then signs in
 * as the owner it created.
 *
 * Credentials are fixed rather than minted per run: the workflow wipes the
 * deployment before each run, so there is nothing to collide with, and a failed
 * run leaves an account someone can actually log into to look around.
 */
const OWNER: TestUser = {
	name: 'E2E Owner',
	email: 'e2e-owner@example.com',
	password: 'TestPassword123!',
};

/** The seeded instance owner. */
export function testUser(): TestUser {
	return { ...OWNER };
}

const contactSeed = Date.now();

export const SAMPLE_CONTACTS = [
	{ email: `contact1-${contactSeed}@example.com`, firstName: 'Alice', lastName: 'Smith' },
	{ email: `contact2-${contactSeed}@example.com`, firstName: 'Bob', lastName: 'Jones' },
	{ email: `contact3-${contactSeed}@example.com`, firstName: 'Carol', lastName: 'Williams' },
] as const;
