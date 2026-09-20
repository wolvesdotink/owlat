import { test, expect } from '@playwright/test';

/**
 * The app mounts in a real browser under the real CSP.
 *
 * Everything else in this suite assumes the app is on screen, so when the shell
 * cannot execute, every one of them fails as an unrelated-looking selector
 * timeout. This one names the cause. It needs no account and no backend data,
 * which is why it runs in its own project with no dependency on the auth setup.
 *
 * The failure it guards is silent by construction: the server answers 200, the
 * HTML is complete, and the browser refuses to run it. `window.__NUXT__.config`
 * is rendered inline per request (that is how a deployment's NUXT_PUBLIC_* reach
 * the client), so blocking inline scripts means `payload.config` is undefined
 * and Nuxt dies reading `.app` before anything renders — a blank window. Every
 * published web image up to 0.4.5 shipped exactly that.
 */
test.describe('app shell', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('boots under the deployment CSP, with no violations', async ({ page }) => {
		await page.addInitScript(() => {
			(window as unknown as { __cspViolations: string[] }).__cspViolations = [];
			document.addEventListener('securitypolicyviolation', (event) => {
				(window as unknown as { __cspViolations: string[] }).__cspViolations.push(
					`${event.violatedDirective} :: ${event.blockedURI || 'inline'}`
				);
			});
		});

		const pageErrors: string[] = [];
		page.on('pageerror', (error) => pageErrors.push(error.message));

		const response = await page.goto('/auth/login');
		expect(response?.status()).toBe(200);

		// Mounted, not merely served: the SPA loading template is replaced only
		// once Vue takes over.
		await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 30_000 });

		const violations = await page.evaluate(
			() => (window as unknown as { __cspViolations: string[] }).__cspViolations
		);
		expect(violations, 'the deployment CSP blocked something the app needs').toEqual([]);
		expect(pageErrors, 'the app threw while booting').toEqual([]);
	});

	test('serves a CSP whose nonce matches the shell it sends', async ({ request }) => {
		// Pins the two halves against each other, so this keeps failing the day
		// Nuxt changes which inline scripts the shell carries: nonce mode is only
		// on because `'nonce-{{nonce}}'` is listed in nuxt.config.ts, and nothing
		// about dropping it looks broken until a browser runs the page.
		//
		// Read off ONE raw response rather than the DOM: the nonce is minted per
		// request, and the browser deliberately hides the attribute from the DOM
		// (readable only as the `.nonce` property), so `getAttribute` sees nothing
		// either way and would pass vacuously.
		const response = await request.get('/auth/login');
		expect(response.status()).toBe(200);

		const csp = response.headers()['content-security-policy'] ?? '';
		const scriptSrc = csp
			.split(';')
			.find((directive) => directive.trim().startsWith('script-src '));
		const nonce = scriptSrc?.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
		expect(
			nonce,
			`script-src carries no nonce, so every inline script in the shell is blocked: ${scriptSrc}`
		).toBeTruthy();

		const html = await response.text();
		const inlineScripts = (html.match(/<script(?![^>]*\ssrc=)[^>]*>/g) ?? []).filter(
			(tag) => !tag.includes('type="application/json"')
		);
		expect(
			inlineScripts.length,
			'no executable inline script in the shell — this assertion would pass vacuously'
		).toBeGreaterThan(0);
		for (const tag of inlineScripts) {
			expect(tag, 'inline script served without the header nonce, so it will not run').toContain(
				`nonce="${nonce}"`
			);
		}
	});
});
