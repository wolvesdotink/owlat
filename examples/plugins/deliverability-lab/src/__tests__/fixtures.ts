/**
 * Deterministic sample emails the engine, gate, and remote-score tests share. A
 * `clean` message passes every check; each of the others trips exactly one
 * analyzer so the tests can assert which check fired without cross-talk. These
 * are the plugin's checked-in fixtures — the same class of inputs a plugin
 * author would keep to pin their rules.
 */

import type { DeliverabilityEmail } from '../engine';

/** Passes spam, link, and accessibility checks. */
export const CLEAN_EMAIL: DeliverabilityEmail = {
	from: 'Aster Team <team@aster.example>',
	subject: 'Your April product update',
	html:
		'<html lang="en"><body>' +
		'<p>Hi there, here is what shipped this month.</p>' +
		'<p><a href="https://aster.example/changelog?utm_source=newsletter">Read the changelog</a></p>' +
		'<img src="https://aster.example/logo.png" alt="Aster logo" />' +
		'</body></html>',
	text: 'Hi there, here is what shipped this month. Read the changelog: https://aster.example/changelog',
};

/** Trips the spam scorer: shouty subject, trigger phrases, no text part. */
export const SPAMMY_EMAIL: DeliverabilityEmail = {
	from: 'WIN BIG <promo@deals.example>',
	subject: 'CONGRATULATIONS!! ACT NOW — 100% FREE MONEY GUARANTEED!!!',
	html:
		'<html lang="en"><body><p>Dear friend, click here to claim your free money now. ' +
		'Winner! Act now, limited time, no obligation, risk free.</p>' +
		'<p><a href="https://deals.example/claim?utm_source=x">Claim</a></p></body></html>',
};

/** Trips the link auditor: insecure http and a bare-IP host. */
export const BROKEN_LINKS_EMAIL: DeliverabilityEmail = {
	from: 'Aster Team <team@aster.example>',
	subject: 'A quick note about your account',
	html:
		'<html lang="en"><body><p>Please review your settings.</p>' +
		'<p><a href="http://aster.example/settings?utm_source=n">Open settings</a></p>' +
		'<p><a href="https://192.168.0.10/admin?utm_source=n">Admin panel</a></p></body></html>',
	text: 'Please review your settings.',
};

/** Trips the accessibility auditor: an image with no alt and an empty-text link. */
export const INACCESSIBLE_EMAIL: DeliverabilityEmail = {
	from: 'Aster Team <team@aster.example>',
	subject: 'This month at Aster',
	html:
		'<html lang="en"><body><p>Highlights from the team.</p>' +
		'<img src="https://aster.example/hero.png" />' +
		'<p><a href="https://aster.example/read?utm_source=n"></a></p></body></html>',
	text: 'Highlights from the team.',
};
