'use node';

/**
 * Booking page — the invite mails.
 *
 * One action per booking event (booked, moved, cancelled) mails the guest and
 * the host, each with an iCalendar part: `METHOD:REQUEST` for a new or moved
 * meeting (same UID, higher SEQUENCE, so calendars update the event) and
 * `METHOD:CANCEL` for a cancellation. The guest's mail carries the cancel and
 * reschedule links when the event minted a manage token.
 *
 * Both go through the system mail transport (`systemMail.ts`), whatever the
 * host's mailbox setup: it works for a member with no mailbox, with an external
 * mailbox, or with Postbox turned off, and it is the path every other
 * machine-generated mail takes. The guest's mail is From "<host> via Owlat"
 * with Reply-To set to the host, so a reply reaches them; the host's has
 * Reply-To set to the guest.
 *
 * Each job carries the calendar sequence its change wrote. Every change to a
 * booking (book, move, cancel) raises the sequence, so a job whose sequence
 * is no longer the booking's has been overtaken by a later change and sends
 * nothing: a confirmation still queued when the booking is cancelled must not
 * reach a calendar as a `REQUEST` after the `CANCEL`.
 *
 * A failed send is logged and not retried; the booking itself stands either
 * way, and the page told the guest it was booked.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { escapeHtml } from '@owlat/shared/html';
import { buildEventICalendar } from '@owlat/shared/ical';
import { APP_LOCALE_BCP47 } from '@owlat/shared/appLocales';
import { redactEmailAddress } from '@owlat/shared/logRedaction';
import { attemptSystemEmail } from '../systemMail';
import { getOptional } from '../lib/env';
import { sanitizeEmailHeaderValue } from '../lib/inputGuards';
import { logWarn } from '../lib/runtimeLog';
import { renderSystemEmail } from '../lib/systemEmails';
import { systemEmailLocale } from '../lib/systemEmailCopy';
import { BOOKING_EMAIL_COPY, type BookingEmailCopy, type BookingMailKind } from './emailCopy';
import { bookingManageUrl } from './model';

const kindValidator = v.union(
	v.literal('confirmed'),
	v.literal('rescheduled'),
	v.literal('cancelled')
);

/** A display name safe inside a quoted From phrase. */
function phrase(value: string): string {
	return value
		.replace(/[\r\n"\\<>]/g, '')
		.trim()
		.slice(0, 80);
}

function formatWhen(start: number, end: number, locale: string, timeZone: string): string {
	const day = new Intl.DateTimeFormat(locale, {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		timeZone,
	}).format(start);
	const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone });
	return `${day}, ${time.format(start)} – ${time.format(end)}`;
}

function row(label: string, valueHtml: string): string {
	return `              <p style="margin: 0 0 4px 0; font-size: 12px; color: #6b635a; text-transform: uppercase; letter-spacing: 0.04em;">${escapeHtml(label)}</p>
              <p style="margin: 0 0 16px 0; font-size: 15px; color: #f5f2ef;">${valueHtml}</p>`;
}

function link(url: string, label: string): string {
	return `<a href="${escapeHtml(url)}" style="color: #c4785a; text-decoration: underline;">${escapeHtml(label)}</a>`;
}

/** The mail body for one reader. Every interpolated value is escaped here. */
export function renderBookingEmail(opts: {
	copy: BookingEmailCopy;
	lang: string;
	heading: string;
	intro: string;
	when: string;
	timeZone: string;
	location?: string;
	videoUrl?: string;
	guestLine?: string;
	note?: string;
	manageUrl?: string;
	isCancelled: boolean;
}): string {
	const { copy } = opts;
	const details = [
		row(copy.when, escapeHtml(opts.when)),
		opts.location ? row(copy.where, escapeHtml(opts.location)) : '',
		opts.videoUrl && !opts.isCancelled
			? row(copy.videoLink, link(opts.videoUrl, opts.videoUrl))
			: '',
		opts.guestLine ? row(copy.guest, escapeHtml(opts.guestLine)) : '',
		opts.note ? row(copy.guestNote, escapeHtml(opts.note).replace(/\n/g, '<br>')) : '',
	].join('\n');
	const manage =
		opts.manageUrl && !opts.isCancelled
			? `              <p style="margin: 8px 0 0 0; font-size: 14px;">${link(opts.manageUrl, copy.reschedule)} · ${link(opts.manageUrl, copy.cancel)}</p>`
			: '';
	const body = `              <h1 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 600; color: #f5f2ef;">${escapeHtml(opts.heading)}</h1>
              <p style="margin: 0 0 24px 0; color: #a09890; font-size: 14px;">${escapeHtml(opts.intro)}</p>
${details}
              <p style="margin: 0 0 8px 0; font-size: 12px; color: #6b635a;">${escapeHtml(copy.timeZoneNote(opts.timeZone))}${opts.isCancelled ? '' : ` ${escapeHtml(copy.calendarHint)}`}</p>
${manage}`;
	return renderSystemEmail({
		title: escapeHtml(opts.heading),
		body,
		footer: escapeHtml(copy.footer),
		lang: opts.lang,
	});
}

export const send = internalAction({
	args: {
		bookingId: v.id('bookings'),
		kind: kindValidator,
		/** The `icalSequence` the change that queued this mail wrote. */
		sequence: v.number(),
		manageToken: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const loaded = await ctx.runQuery(internal.booking.public.loadForEmail, {
			bookingId: args.bookingId,
		});
		if (!loaded) return;
		const { booking, host } = loaded;
		const kind: BookingMailKind = args.kind;
		const isCancelled = kind === 'cancelled';
		// Overtaken by a later change, which queued its own mail.
		if (booking.icalSequence !== args.sequence) return;
		if (isCancelled !== (booking.status === 'cancelled')) return;
		const now = new Date();
		const ics = buildEventICalendar({
			method: isCancelled ? 'CANCEL' : 'REQUEST',
			uid: booking.icalUid,
			sequence: booking.icalSequence,
			start: new Date(booking.startAt),
			end: new Date(booking.endAt),
			summary: booking.title,
			description: booking.guestNote,
			location: booking.location ?? booking.videoUrl,
			url: booking.videoUrl,
			organizer: { name: host.name, email: host.email },
			attendees: [{ name: booking.guestName, email: booking.guestEmail }],
			now,
		});
		const method = isCancelled ? 'CANCEL' : 'REQUEST';
		const attachments = [
			{
				filename: isCancelled ? 'cancel.ics' : 'invite.ics',
				contentType: `text/calendar; method=${method}; charset=utf-8`,
				contentBase64: Buffer.from(ics, 'utf-8').toString('base64'),
			},
		];
		const fromDomain = getOptional('DEFAULT_FROM_DOMAIN') || 'mail.owlat.app';
		const from = `"${phrase(host.name)} via Owlat" <noreply@${fromDomain}>`;

		// The guest, in the language their browser asked the page for.
		const guestLocale = systemEmailLocale(booking.guestLocale?.split('-')[0]);
		const guestCopy = BOOKING_EMAIL_COPY[guestLocale];
		const guestZone = booking.guestTimeZone ?? host.timeZone;
		const guestHtml = renderBookingEmail({
			copy: guestCopy,
			lang: guestLocale,
			heading: guestCopy.guestHeading[kind],
			intro: guestCopy.guestIntro[kind](host.name),
			when: formatWhen(booking.startAt, booking.endAt, APP_LOCALE_BCP47[guestLocale], guestZone),
			timeZone: guestZone,
			location: booking.location,
			videoUrl: booking.videoUrl,
			manageUrl: args.manageToken ? bookingManageUrl(args.manageToken) : undefined,
			isCancelled,
		});

		// The host, in their profile language and their page's zone.
		const hostLocale = systemEmailLocale(host.locale);
		const hostCopy = BOOKING_EMAIL_COPY[hostLocale];
		const hostHtml = renderBookingEmail({
			copy: hostCopy,
			lang: hostLocale,
			heading: hostCopy.hostHeading[kind],
			intro: hostCopy.hostIntro[kind](booking.guestName),
			when: formatWhen(booking.startAt, booking.endAt, APP_LOCALE_BCP47[hostLocale], host.timeZone),
			timeZone: host.timeZone,
			location: booking.location,
			videoUrl: booking.videoUrl,
			guestLine: `${booking.guestName} <${booking.guestEmail}>`,
			note: booking.guestNote,
			isCancelled,
		});

		const sends = [
			{
				to: booking.guestEmail,
				subject: guestCopy.guestSubject[kind](booking.title, host.name),
				html: guestHtml,
				replyTo: host.email,
				reader: 'guest',
			},
			{
				to: host.email,
				subject: hostCopy.hostSubject[kind](booking.title, booking.guestName),
				html: hostHtml,
				replyTo: booking.guestEmail,
				reader: 'host',
			},
		];
		for (const mail of sends) {
			const outcome = await attemptSystemEmail(ctx, {
				to: mail.to,
				from,
				// Title and names are free text: one header line, whatever they hold.
				subject: sanitizeEmailHeaderValue(mail.subject),
				html: mail.html,
				replyTo: mail.replyTo,
				attachments,
				idempotencyKey: `booking-${booking._id}-${booking.icalSequence}-${kind}-${mail.reader}`,
			});
			if (outcome.status === 'failed') {
				logWarn('[Booking] invite mail failed', {
					bookingId: booking._id,
					reader: mail.reader,
					to: redactEmailAddress(mail.to),
					errorCode: outcome.errorCode,
				});
			}
		}
	},
});
