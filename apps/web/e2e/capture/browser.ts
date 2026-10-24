/**
 * The browser half of `bun run capture`: one Chrome context with the pair's
 * presentation, a real sign-in through the login form, then every planned shot
 * in order. Nothing is mocked: the app, its Convex backend and Better Auth are
 * the ones `bun run dev:stack` runs.
 */

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { WELCOMED_STORAGE_PREFIX } from '../../app/lib/welcomedCache';
import type { CaptureManifest, PlannedShot } from './options';
import { BOOT_TIMEOUT_MS, CaptureFailure, openRoute, SURFACES } from './surfaces';

export interface Credentials {
	readonly email: string;
	readonly password: string;
}

/**
 * Mirrors the owner `scripts/dev-seed.ts` creates. OWLAT_CAPTURE_EMAIL and
 * OWLAT_CAPTURE_PASSWORD override it for a stack whose owner predates the seed.
 */
export function captureCredentials(env: NodeJS.ProcessEnv): Credentials {
	return {
		email: env['OWLAT_CAPTURE_EMAIL'] || 'dev@example.com',
		password: env['OWLAT_CAPTURE_PASSWORD'] || 'devpassword12345',
	};
}

/** `nuxt dev`'s own overlays: present in dev only, never part of the product. */
const HIDE_DEV_OVERLAYS =
	'#nuxt-devtools-container, nuxt-devtools-inspect-panel, #vue-tracer-overlay { display: none !important; }';

const SETTLE_TIMEOUT_MS = 30_000;
/** How long the DOM must stay unchanged before a shot. */
const QUIET_MS = 1_500;

async function launch(): Promise<Browser> {
	try {
		return await chromium.launch({ channel: 'chrome' });
	} catch {
		try {
			return await chromium.launch();
		} catch (error) {
			throw new CaptureFailure(
				"Could not start Chrome. Install Google Chrome, or Playwright's Chromium with " +
					`\`bunx playwright install chromium\`.\n${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
}

async function newContext(browser: Browser, manifest: CaptureManifest): Promise<BrowserContext> {
	const context = await browser.newContext({
		viewport: { ...manifest.viewport },
		deviceScaleFactor: 1,
		colorScheme: manifest.theme,
		reducedMotion: 'reduce',
		locale: 'en-US',
		timezoneId: 'UTC',
	});
	// The app's own theme preference (@nuxtjs/color-mode, storageKey in
	// nuxt.config.ts), so a saved choice cannot override the requested theme.
	await context.addInitScript((theme) => {
		localStorage.setItem('owlat-theme', theme);
	}, manifest.theme);
	// Shifted, not frozen: time keeps running from the pair's recorded start, so
	// timers and token refreshes behave normally.
	await context.clock.setSystemTime(new Date(manifest.clock));
	return context;
}

async function signIn(page: Page, appUrl: string, credentials: Credentials): Promise<void> {
	await openRoute(page, appUrl, '/auth/login');
	await page.getByLabel('Email').fill(credentials.email);
	// Exact: the show/hide toggle is labelled "Show password".
	await page.getByLabel('Password', { exact: true }).fill(credentials.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	const left = page
		.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: SETTLE_TIMEOUT_MS })
		.then(() => true);
	const refused = page
		.locator('.bg-error-subtle')
		.first()
		.waitFor({ state: 'visible', timeout: SETTLE_TIMEOUT_MS })
		.then(() => false);
	const signedIn = await Promise.any([left, refused]).catch(() => false);
	if (!signedIn) {
		throw new CaptureFailure(
			`Signing in as ${credentials.email} failed. Seed the stack with \`bun run dev:seed\`, ` +
				'or set OWLAT_CAPTURE_EMAIL and OWLAT_CAPTURE_PASSWORD for an owner created another way.'
		);
	}
	// A member who never saw /welcome is sent there from the dashboard and the
	// Postbox. Visiting it once records the visit on the server and in this
	// browser, so no later navigation is redirected mid-capture.
	await openRoute(page, appUrl, '/welcome');
	await page
		.waitForFunction(
			(prefix) => Object.keys(localStorage).some((key) => key.startsWith(prefix)),
			WELCOMED_STORAGE_PREFIX,
			{ timeout: SETTLE_TIMEOUT_MS }
		)
		.catch(() => {
			throw new CaptureFailure('The welcome screen never recorded the visit.');
		});
}

/** The Nuxt error the page rendered instead of the route, if any. */
async function renderedError(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const root = document.querySelector('#__nuxt') as
			| (Element & {
					__vue_app__?: {
						config: {
							globalProperties: {
								$nuxt?: { payload?: { error?: { statusCode?: number; message?: string } | null } };
							};
						};
					};
			  })
			| null;
		const error = root?.__vue_app__?.config.globalProperties.$nuxt?.payload?.error;
		return error ? `${error.statusCode ?? 'error'} ${error.message ?? ''}`.trim() : null;
	});
}

/**
 * Waits until the page is done loading what it shows: no visible loading
 * placeholder (the shared skeleton, `packages/ui/components/ui/Skeleton.vue`,
 * or an element marked aria-busy), fonts loaded, the DOM unchanged for
 * {@link QUIET_MS}, and two frames painted after that. Focus is dropped first,
 * so the ring and the focus-only controls of the last clicked element are not
 * captured.
 */
async function settle(page: Page, name: string, viewportHeight: number): Promise<void> {
	await page.locator('.owlat-spa').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
	const path = new URL(page.url()).pathname;
	if (path.startsWith('/auth')) {
		throw new CaptureFailure(`${name}: the app sent the browser back to sign-in (${path}).`);
	}
	const error = await renderedError(page);
	if (error) throw new CaptureFailure(`${name}: the app rendered its error page (${error}).`);
	try {
		await page.waitForFunction(
			() =>
				document.fonts.status === 'loaded' &&
				![...document.querySelectorAll('.ui-skeleton, [aria-busy="true"]')].some(
					(element) => (element as HTMLElement).offsetParent !== null
				),
			undefined,
			{ timeout: SETTLE_TIMEOUT_MS }
		);
	} catch {
		throw new CaptureFailure(
			`${name}: the page was still loading after ${SETTLE_TIMEOUT_MS / 1000}s.`
		);
	}
	// Off every control, so no hover state from the last click is captured.
	await page.mouse.move(0, viewportHeight - 1);
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	// Not every late part has a placeholder (a sidebar list, a picker that shows
	// an empty note until its options arrive), so also wait for the DOM to stop
	// changing. A page that never does is reported rather than captured midway.
	const quiet = await page.evaluate(
		({ quietMs, timeoutMs }) =>
			new Promise<boolean>((done) => {
				const finish = (settled: boolean) => {
					observer.disconnect();
					clearTimeout(quietTimer);
					clearTimeout(deadline);
					done(settled);
				};
				const observer = new MutationObserver(() => {
					clearTimeout(quietTimer);
					quietTimer = setTimeout(finish, quietMs, true);
				});
				let quietTimer = setTimeout(finish, quietMs, true);
				const deadline = setTimeout(finish, timeoutMs, false);
				observer.observe(document.body, {
					subtree: true,
					childList: true,
					attributes: true,
					characterData: true,
				});
			}),
		{ quietMs: QUIET_MS, timeoutMs: SETTLE_TIMEOUT_MS }
	);
	if (!quiet) {
		throw new CaptureFailure(
			`${name}: the page kept changing for ${SETTLE_TIMEOUT_MS / 1000}s; nothing to capture reliably.`
		);
	}
	await page.evaluate(
		() =>
			new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
	);
}

export async function shootAll(
	appUrl: string,
	credentials: Credentials,
	shots: readonly PlannedShot[],
	manifest: CaptureManifest,
	log: (line: string) => void
): Promise<Uint8Array[]> {
	const browser = await launch();
	try {
		const context = await newContext(browser, manifest);
		const page = await context.newPage();
		log(`Signing in to ${appUrl} as ${credentials.email}...`);
		await signIn(page, appUrl, credentials);
		const images: Uint8Array[] = [];
		for (const shot of shots) {
			log(`Capturing ${shot.name}...`);
			if (shot.path !== undefined) {
				await openRoute(page, appUrl, shot.path);
			} else {
				const surface = SURFACES.find((candidate) => candidate.name === shot.name);
				if (!surface) throw new CaptureFailure(`Unknown surface ${shot.name}.`);
				await surface.open(page, appUrl);
			}
			await settle(page, shot.name, manifest.viewport.height);
			images.push(
				await page.screenshot({
					animations: 'disabled',
					caret: 'hide',
					fullPage: manifest.fullPage,
					style: HIDE_DEV_OVERLAYS,
				})
			);
		}
		return images;
	} finally {
		await browser.close();
	}
}
