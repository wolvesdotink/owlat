/**
 * Pure-function tests for the deterministic pre-send reference monitor. Covers
 * the recipient lock, the local DLP pass, and the outbound HTML sanitizer — the
 * data-isolation backstop applied immediately before an autonomous auto-send.
 */

import { describe, it, expect } from 'vitest';
import {
	deriveAuthenticatedRecipient,
	sanitizeOutboundHtml,
	runReferenceMonitor,
} from '../referenceMonitor';

describe('deriveAuthenticatedRecipient', () => {
	it('extracts the address from a "Name <addr>" inbound From', () => {
		expect(deriveAuthenticatedRecipient('Alice Customer <alice@customer.example>')).toBe(
			'alice@customer.example',
		);
	});
	it('returns undefined when nothing address-shaped is present', () => {
		expect(deriveAuthenticatedRecipient('')).toBeUndefined();
		expect(deriveAuthenticatedRecipient('no address here')).toBeUndefined();
	});
});

describe('sanitizeOutboundHtml', () => {
	it('strips remote images / tracking pixels', () => {
		const html =
			'<div>Hi<img src="https://tracker.evil/pixel.gif" width="1" height="1"></div>';
		const out = sanitizeOutboundHtml(html, ['customer.example']);
		expect(out.strippedRemoteImages).toBe(1);
		expect(out.html).not.toContain('<img');
		expect(out.html).toContain('Hi');
	});

	it('neutralizes off-allowlist link hosts but keeps allow-listed and relative links', () => {
		const html =
			'<a href="https://evil.example/steal">click</a>' +
			'<a href="https://mail.corp.test/ok">safe</a>' +
			'<a href="/relative">rel</a>';
		const out = sanitizeOutboundHtml(html, ['mail.corp.test']);
		expect(out.neutralizedLinks).toBe(1);
		expect(out.html).not.toContain('evil.example');
		expect(out.html).toContain('click'); // text preserved
		expect(out.html).toContain('https://mail.corp.test/ok');
		expect(out.html).toContain('/relative');
	});

	it('leaves a clean escaped-text draft untouched', () => {
		const html = '<div>Thanks for your order, it ships Tuesday.</div>';
		const out = sanitizeOutboundHtml(html, ['corp.test']);
		expect(out.html).toBe(html);
		expect(out.strippedRemoteImages).toBe(0);
		expect(out.neutralizedLinks).toBe(0);
	});
});

describe('runReferenceMonitor', () => {
	const base = {
		inboundFrom: 'Alice Customer <alice@customer.example>',
		resolvedRecipient: 'alice@customer.example',
		draftText: 'Thanks for reaching out — your order ships Tuesday.',
		draftHtml: '<div>Thanks for reaching out — your order ships Tuesday.</div>',
		allowedLinkHosts: ['corp.test'],
	};

	it('passes a clean routine reply to the authenticated sender', () => {
		const res = runReferenceMonitor(base);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.html).toBe(base.draftHtml);
	});

	it('withholds when the resolved recipient does not match the authenticated sender', () => {
		const res = runReferenceMonitor({ ...base, resolvedRecipient: 'attacker@evil.example' });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toMatch(/does not match the authenticated inbound sender/i);
	});

	it('matches the sender case-insensitively', () => {
		const res = runReferenceMonitor({ ...base, resolvedRecipient: 'ALICE@Customer.Example' });
		expect(res.ok).toBe(true);
	});

	it('withholds when the inbound sender is unresolvable', () => {
		const res = runReferenceMonitor({ ...base, inboundFrom: 'garbage' });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toMatch(/could not derive an authenticated recipient/i);
	});

	it('withholds when the draft hands out a one-time passcode', () => {
		const res = runReferenceMonitor({
			...base,
			draftText: 'Your verification code is 481920, enter it now.',
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toMatch(/sensitive data \(otp_code\)/i);
	});

	it('withholds when the draft contains an account-recovery link', () => {
		const res = runReferenceMonitor({
			...base,
			draftText: 'Reset here: https://accounts.example.com/reset-password?reset_token=xyz',
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toMatch(/sensitive data \(recovery_link\)/i);
	});

	it('strips a remote image on the clean path and still sends (ok)', () => {
		const res = runReferenceMonitor({
			...base,
			draftHtml: '<div>Hi<img src="https://tracker.evil/p.gif"></div>',
		});
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.strippedRemoteImages).toBe(1);
			expect(res.html).not.toContain('<img');
		}
	});
});
