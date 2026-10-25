/**
 * The browser half of `bun run capture`: one Chrome context with the pair's
 * presentation, a real sign-in through the login form, then every planned shot
 * in order. Nothing is mocked: the app, its Convex backend and Better Auth are
 * the ones `bun run dev:stack` runs.
 */

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { WELCOMED_STORAGE_PREFIX } from '../../app/lib/welcomedCache';
import type { CaptureManifest, PlannedShot } from './options';
import { QUIET_MS, SETTLE_TIMEOUT_MS, shootWhenSettled, type PageChecks } from './settle';
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

/** Fonts loaded and no visible loading placeholder, evaluated in the page. */
function pageLoaded(): boolean {
	return (
		document.fonts.status === 'loaded' &&
		![...document.querySelectorAll('.ui-skeleton, [aria-busy="true"]')].some(
			(element) => (element as HTMLElement).offsetParent !== null
		)
	);
}

/**
 * The checks {@link shootWhenSettled} runs on this page. A loading placeholder
 * is the shared skeleton (`packages/ui/components/ui/Skeleton.vue`) or an
 * element marked aria-busy.
 */
function pageChecks(page: Page, manifest: CaptureManifest): PageChecks {
	return {
		async blocker() {
			const path = new URL(page.url()).pathname;
			if (path.startsWith('/auth')) return `the app sent the browser back to sign-in (${path}).`;
			const error = await renderedError(page);
			return error ? `the app rendered its error page (${error}).` : null;
		},
		loaded: () => page.evaluate(pageLoaded),
		waitLoaded: () =>
			page
				.waitForFunction(pageLoaded, undefined, { timeout: SETTLE_TIMEOUT_MS })
				.then(() => true)
				.catch(() => false),
		waitQuiet: () =>
			page.evaluate(
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
			),
		paint: () =>
			page.evaluate(
				() =>
					new Promise<void>((done) =>
						requestAnimationFrame(() => requestAnimationFrame(() => done()))
					)
			),
		screenshot: () =>
			page.screenshot({
				animations: 'disabled',
				caret: 'hide',
				fullPage: manifest.fullPage,
				style: HIDE_DEV_OVERLAYS,
			}),
	};
}

/**
 * The shot of the page the browser is on, once it has loaded. Focus and the
 * mouse are moved off every control first, so no focus ring, hover state or
 * focus-only control of the last clicked element is captured.
 */
async function shoot(page: Page, name: string, manifest: CaptureManifest): Promise<Uint8Array> {
	await page.locator('.owlat-spa').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
	await page.mouse.move(0, manifest.viewport.height - 1);
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	return shootWhenSettled(name, pageChecks(page, manifest));
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
			images.push(await shoot(page, shot.name, manifest));
		}
		return images;
	} finally {
		await browser.close();
	}
}
