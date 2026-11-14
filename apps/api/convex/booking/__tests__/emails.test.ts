import { afterEach, describe, expect, it, vi } from 'vitest';
import { bookingInviteFrom, renderBookingEmail } from '../emails';
import { BOOKING_EMAIL_COPY } from '../emailCopy';

describe('renderBookingEmail', () => {
	const base = {
		copy: BOOKING_EMAIL_COPY.en,
		lang: 'en',
		heading: 'Your meeting is booked',
		intro: 'You booked a meeting with <Ada>.',
		when: 'Monday, March 2, 2026, 10:00 AM – 10:30 AM',
		timeZone: 'Europe/Berlin',
		isCancelled: false,
	};

	it('escapes every value a guest or host typed', () => {
		const html = renderBookingEmail({
			...base,
			location: '<script>alert(1)</script>',
			note: 'see you\n<b>soon</b>',
			guestLine: 'Grace "G" <grace@example.com>',
		});
		expect(html).not.toContain('<script>');
		expect(html).not.toContain('<b>soon');
		expect(html).toContain('&lt;Ada&gt;');
		expect(html).toContain('see you<br>&lt;b&gt;soon');
	});

	it('links the guest to reschedule and cancel, and drops the links once cancelled', () => {
		const manageUrl = 'https://owlat.example.com/book/manage?token=bk_abc';
		const html = renderBookingEmail({
			...base,
			manageUrl,
			videoUrl: 'https://video.example.com/x',
		});
		expect(html).toContain('Pick another time');
		expect(html).toContain('Cancel the meeting');
		expect(html).toContain('https://video.example.com/x');
		const cancelled = renderBookingEmail({ ...base, manageUrl, isCancelled: true });
		expect(cancelled).not.toContain(manageUrl);
		expect(cancelled).not.toContain('attached invite');
	});

	it('speaks German with du', () => {
		const html = renderBookingEmail({
			...base,
			copy: BOOKING_EMAIL_COPY.de,
			lang: 'de',
			heading: BOOKING_EMAIL_COPY.de.guestHeading.confirmed,
			intro: BOOKING_EMAIL_COPY.de.guestIntro.confirmed('Ada'),
		});
		expect(html).toContain('Dein Termin ist gebucht');
		expect(html).not.toMatch(/\bSie\b|\bIhr\b/);
	});
});

describe('bookingInviteFrom', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('names the host in front of the configured system sender', () => {
		vi.stubEnv('DEFAULT_FROM_DOMAIN', 'mail.example.com');
		expect(bookingInviteFrom('Ada "the host" <x>')).toBe(
			'"Ada the host x via Owlat" <noreply@mail.example.com>'
		);
	});

	it('has no From when no sender is configured, so the invite is skipped', () => {
		vi.stubEnv('DEFAULT_FROM_DOMAIN', '');
		vi.stubEnv('DEFAULT_FROM_EMAIL', '');
		expect(bookingInviteFrom('Ada')).toBeNull();
	});
});
