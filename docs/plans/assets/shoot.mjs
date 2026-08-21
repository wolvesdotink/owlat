// Screenshot each [data-shot] section of the before/after mockup page into a
// PNG for the PR description. Run: node docs/plans/assets/shoot.mjs
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = path.join(here, 'mailbox-ux-before-after.html');
const exec = process.env.PLAYWRIGHT_CHROMIUM;

const browser = await chromium.launch({
	executablePath: exec,
	args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 2 });
await page.goto(`file://${html}`);
await page.waitForTimeout(1200); // fonts

for (const section of await page.locator('[data-shot]').all()) {
	const name = await section.getAttribute('data-shot');
	await section.screenshot({ path: path.join(here, `${name}.png`) });
	console.log('shot', name);
}

await browser.close();
