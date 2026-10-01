import { test, expect, type Page } from '@playwright/test';
import { LoginPage } from '../page-objects/LoginPage';
import { testUser } from '../fixtures/test-data';

/**
 * Visits that start on a public page (/terms, /imprint) and then follow a link
 * into the app. The Convex client is created once, at boot, and a public page
 * gives it no auth; entering the app by SPA navigation must authenticate it
 * without a reload. A visit that stays public asks for no session or token.
 */

const SESSION_OR_TOKEN = /\/api\/auth\/(get-session|convex\/token)/;

/** Record the auth traffic of a page: session/token requests and Convex auth frames. */
function watchAuth(page: Page) {
	const authRequests: string[] = [];
	const userAuthFrames: string[] = [];
	const notAuthenticated: string[] = [];
	page.on('request', (request) => {
		if (SESSION_OR_TOKEN.test(request.url())) authRequests.push(request.url());
	});
	page.on('websocket', (socket) => {
		socket.on('framesent', (frame) => {
			const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString();
			// The Convex client sends the user's JWT in an Authenticate message.
			if (payload.includes('"Authenticate"') && payload.includes('"User"')) {
				userAuthFrames.push(payload);
			}
		});
	});
	page.on('console', (message) => {
		if (message.type() === 'error' && message.text().includes('Not authenticated')) {
			notAuthenticated.push(message.text());
		}
	});
	return { authRequests, userAuthFrames, notAuthenticated };
}

/** Mark the document, so a later check can tell a SPA navigation from a reload. */
async function markDocument(page: Page) {
	await page.evaluate(() => {
		(window as unknown as { __publicEntryMark?: boolean }).__publicEntryMark = true;
	});
}

async function documentWasKept(page: Page): Promise<boolean> {
	return page.evaluate(
		() => (window as unknown as { __publicEntryMark?: boolean }).__publicEntryMark === true
	);
}

test.describe('Public-first visit, signed out', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('a visit that stays on public pages asks for no session or token', async ({ page }) => {
		const auth = watchAuth(page);

		await page.goto('/terms');
		await page.waitForLoadState('networkidle');
		await page.goto('/imprint');
		await page.waitForLoadState('networkidle');

		expect(auth.authRequests).toEqual([]);
		expect(auth.userAuthFrames).toEqual([]);
	});

	test('/terms → sign in → dashboard authenticates Convex without a reload', async ({ page }) => {
		const auth = watchAuth(page);

		await page.goto('/terms');
		await page.waitForLoadState('networkidle');
		await markDocument(page);

		await page.getByRole('link', { name: 'Sign in', exact: true }).click();
		await page.waitForURL('**/auth/login**');

		const TEST_USER = testUser();
		await new LoginPage(page).login(TEST_USER.email, TEST_USER.password);
		await page.waitForURL('**/dashboard**', { timeout: 15_000 });

		await expect.poll(() => auth.userAuthFrames.length, { timeout: 15_000 }).toBeGreaterThan(0);
		expect(await documentWasKept(page)).toBe(true);
		expect(auth.notAuthenticated).toEqual([]);
	});
});

test.describe('Public-first visit, signed in', () => {
	test('/imprint → the app reaches the dashboard with an authenticated client', async ({
		page,
	}) => {
		const auth = watchAuth(page);

		await page.goto('/imprint');
		await page.waitForLoadState('networkidle');
		await markDocument(page);

		// The sign-in page's guest guard sends a signed-in visitor on to the app.
		await page.getByRole('link', { name: 'Sign in', exact: true }).click();
		await page.waitForURL('**/dashboard**', { timeout: 15_000 });

		await expect.poll(() => auth.userAuthFrames.length, { timeout: 15_000 }).toBeGreaterThan(0);
		expect(await documentWasKept(page)).toBe(true);
		expect(auth.notAuthenticated).toEqual([]);
	});
});
