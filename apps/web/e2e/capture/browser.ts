/**
 * The browser half of `bun run capture`: one Chrome context with the pair's
 * presentation, a real sign-in through the login form (unless the pair is
 * signed out), then every planned shot in order. Nothing is mocked: the app, its Convex backend and Better Auth are
 * the ones `bun run dev:stack` runs.
 */

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { WELCOMED_STORAGE_PREFIX } from '../../app/lib/welcomedCache';
import type { AppLocale } from '@owlat/shared/appLocales';
import { LOCALE_COOKIE } from '../../i18n/areaRuntime';
import type { CaptureManifest } from './manifest';
import type { CaptureStep, Credentials, PlannedShot } from './options';
import {
	QUIET_MS,
	SETTLE_TIMEOUT_MS,
	shootWhenSettled,
	TICK_GRACE_MS,
	type PageChecks,
} from './settle';
import { BOOT_TIMEOUT_MS, CaptureFailure, openRoute, READY_TIMEOUT_MS, SURFACES } from './surfaces';

/** The browser's own language for each app locale, which dates and numbers follow. */
const BROWSER_LOCALES: Readonly<Record<AppLocale, string>> = { en: 'en-US', de: 'de-DE' };

/**
 * The app picks its language from the `owlat-locale` cookie, then from the
 * browser's languages (`I18N_OPTIONS` in i18n/catalogModule.ts); the
 * language stored on the account only reaches emails. Setting the cookie is
 * what the language picker does, so the whole UI switches.
 */
async function setAppLocale(
	context: BrowserContext,
	appUrl: string,
	locale: AppLocale
): Promise<void> {
	await context.addCookies([{ name: LOCALE_COOKIE, value: locale, url: appUrl }]);
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
		locale: BROWSER_LOCALES[manifest.locale],
		timezoneId: 'UTC',
	});
	// The app's own theme preference (@nuxtjs/color-mode, storageKey in
	// nuxt.config.ts), so a saved choice cannot override the requested theme.
	await context.addInitScript((theme) => {
		localStorage.setItem('owlat-theme', theme);
	}, manifest.theme);
	// Shifted, not frozen: time keeps running from the pair's recorded start, so
	// timers and token refreshes behave normally. A page that keeps ticking is
	// frozen only for its own shot (`freezeTimers`).
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
	/** The page's own time when its timers were frozen, restored when they run again. */
	let frozenAt = 0;
	return {
		async blocker() {
			const path = new URL(page.url()).pathname;
			if (manifest.account !== 'signed-out' && path.startsWith('/auth')) {
				return `the app sent the browser back to sign-in (${path}).`;
			}
			const error = await renderedError(page);
			return error ? `the app rendered its error page (${error}).` : null;
		},
		loaded: () => page.evaluate(pageLoaded),
		waitLoaded: () =>
			page
				.waitForFunction(pageLoaded, undefined, { timeout: SETTLE_TIMEOUT_MS })
				.then(() => true)
				.catch(() => false),
		// The quiet and paint waits use the browser's own timers: the app's are
		// Playwright's clock (`context.clock`), which `freezeTimers` stops.
		waitQuiet: (timeoutMs) =>
			page.evaluate(
				({ quietMs, timeoutMs }) =>
					new Promise<boolean>((done) => {
						const { setTimeout, clearTimeout } =
							(globalThis as { __pwClock?: { builtins: typeof globalThis } }).__pwClock?.builtins ??
							globalThis;
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
				{ quietMs: QUIET_MS, timeoutMs }
			),
		async freezeTimers() {
			// A little ahead of the page's clock: pausing cannot move it backwards.
			frozenAt = (await page.evaluate(() => Date.now())) + 1_000;
			await page.clock.pauseAt(frozenAt);
			// Then fixed at the pair's recorded start plus one second, whatever
			// each run spent getting here, and one second of timers runs so every
			// ticking label renders that moment: both labels of a pair show the
			// same seconds on a countdown.
			await page.clock.setFixedTime(new Date(Date.parse(manifest.clock) + 1_000));
			await page.clock.runFor(1_000);
		},
		async thawTimers() {
			// Back to the time this run had reached, so later shots are not rewound.
			await page.clock.setSystemTime(new Date(frozenAt));
			await page.clock.resume();
		},
		paint: () =>
			page.evaluate(
				() =>
					new Promise<void>((done) => {
						const { requestAnimationFrame } =
							(globalThis as { __pwClock?: { builtins: typeof globalThis } }).__pwClock?.builtins ??
							globalThis;
						requestAnimationFrame(() => requestAnimationFrame(() => done()));
					})
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

function describeStep(step: CaptureStep): string {
	switch (step.action) {
		case 'press':
			return `--press ${step.key}`;
		case 'fill':
			return `--fill ${step.target}`;
		default:
			return `--${step.action} ${step.target}`;
	}
}

/**
 * A `--path` shot's steps, in order. A selector that matches more than one
 * element fails the step (Playwright's strict mode) instead of acting on
 * whichever comes first.
 */
async function runSteps(page: Page, name: string, steps: readonly CaptureStep[]): Promise<void> {
	for (const step of steps) {
		try {
			if (step.action === 'click') {
				await page.locator(step.target).click({ timeout: READY_TIMEOUT_MS });
			} else if (step.action === 'fill') {
				await page.locator(step.target).fill(step.value, { timeout: READY_TIMEOUT_MS });
			} else if (step.action === 'press') {
				await page.keyboard.press(step.key);
			} else {
				await page.locator(step.target).waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS });
			}
		} catch (error) {
			const matches =
				'target' in step
					? await page
							.locator(step.target)
							.count()
							.catch(() => null)
					: null;
			const reason =
				matches === 0
					? 'no element matches the selector'
					: matches !== null && matches > 1
						? `${matches} elements match the selector; it must match one`
						: (error instanceof Error ? error.message : String(error)).split('\n')[0];
			throw new CaptureFailure(`${name}: ${describeStep(step)} failed: ${reason}`);
		}
	}
}

/**
 * The shot of the page the browser is on, once it has loaded. The mouse is
 * moved off every control first, and so is focus unless the shot took steps
 * (a typed value or an open menu can depend on it), so no focus ring, hover
 * state or focus-only control of the last clicked element is captured.
 */
async function shoot(
	page: Page,
	shot: PlannedShot,
	manifest: CaptureManifest
): Promise<Uint8Array> {
	await page.locator('.owlat-spa').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
	const checks = pageChecks(page, manifest);
	const steps = shot.steps ?? [];
	if (steps.length > 0) {
		// Steps act on the loaded page, not on what shows while it loads: an
		// empty state can carry a second copy of the button a step clicks.
		// A page that keeps ticking is acted on once the grace period is over.
		if (!(await checks.waitLoaded())) {
			throw new CaptureFailure(
				`${shot.name}: the page was still loading after ${SETTLE_TIMEOUT_MS / 1000}s; no step was taken.`
			);
		}
		await checks.waitQuiet(TICK_GRACE_MS);
		await runSteps(page, shot.name, steps);
	}
	await page.mouse.move(0, manifest.viewport.height - 1);
	if (steps.length === 0) {
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	}
	return shootWhenSettled(shot.name, checks);
}

export async function shootAll(
	appUrl: string,
	credentials: Credentials | null,
	shots: readonly PlannedShot[],
	manifest: CaptureManifest,
	log: (line: string) => void
): Promise<Uint8Array[]> {
	const browser = await launch();
	try {
		const context = await newContext(browser, manifest);
		const page = await context.newPage();
		if (credentials) {
			// The sign-in form is found by its English labels, whatever the pair's language.
			await setAppLocale(context, appUrl, 'en');
			log(`Signing in to ${appUrl} as ${credentials.email}...`);
			await signIn(page, appUrl, credentials);
		} else {
			log(`Capturing ${appUrl} signed out...`);
		}
		await setAppLocale(context, appUrl, manifest.locale);
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
			images.push(await shoot(page, shot, manifest));
		}
		return images;
	} finally {
		await browser.close();
	}
}
