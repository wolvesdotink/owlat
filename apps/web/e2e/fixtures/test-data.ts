import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface TestUser {
	name: string;
	email: string;
	password: string;
}

/**
 * The account `auth.setup.ts` registers is persisted next to the storage state
 * it produces. Every Playwright project loads this module in its own worker,
 * so a module-level `Date.now()` handed the setup project one e-mail and the
 * chromium project another; the login specs then signed in as a user nobody
 * had registered.
 */
const REGISTERED_USER_FILE = resolve(__dirname, '..', '.auth', 'test-user.json');

const TEST_PASSWORD = 'TestPassword123!';

/** A fresh account for the setup project to register, written for the specs. */
export function registerTestUser(): TestUser {
	const user: TestUser = {
		name: 'E2E Test User',
		email: `e2e-test-${Date.now()}@example.com`,
		password: TEST_PASSWORD,
	};
	mkdirSync(dirname(REGISTERED_USER_FILE), { recursive: true });
	writeFileSync(REGISTERED_USER_FILE, JSON.stringify(user));
	return user;
}

/** The account the setup project registered for this run. */
export function testUser(): TestUser {
	if (!existsSync(REGISTERED_USER_FILE)) {
		throw new Error(
			`${REGISTERED_USER_FILE} is missing: the setup project (auth.setup.ts) registers the ` +
				'test user and writes it there. Run the suite through playwright.config.ts.'
		);
	}
	return JSON.parse(readFileSync(REGISTERED_USER_FILE, 'utf8')) as TestUser;
}

const contactSeed = Date.now();

export const SAMPLE_CONTACTS = [
	{ email: `contact1-${contactSeed}@example.com`, firstName: 'Alice', lastName: 'Smith' },
	{ email: `contact2-${contactSeed}@example.com`, firstName: 'Bob', lastName: 'Jones' },
	{ email: `contact3-${contactSeed}@example.com`, firstName: 'Carol', lastName: 'Williams' },
] as const;
