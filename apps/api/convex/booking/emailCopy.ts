/**
 * The sentences of the booking mails, in the reader's language.
 *
 * The guest reads theirs in the language their browser asked the booking page
 * for (stored on the booking); the host in their profile language. Absent or
 * unknown means English, as for every system mail (`lib/systemEmailCopy.ts`).
 * German addresses the reader with "du".
 */

import type { AppLocale } from '@owlat/shared/appLocales';

export type BookingMailKind = 'confirmed' | 'rescheduled' | 'cancelled';

export interface BookingEmailCopy {
	guestSubject: Record<BookingMailKind, (title: string, host: string) => string>;
	guestHeading: Record<BookingMailKind, string>;
	guestIntro: Record<BookingMailKind, (host: string) => string>;
	hostSubject: Record<BookingMailKind, (title: string, guest: string) => string>;
	hostHeading: Record<BookingMailKind, string>;
	hostIntro: Record<BookingMailKind, (guest: string) => string>;
	when: string;
	where: string;
	videoLink: string;
	guestNote: string;
	guest: string;
	timeZoneNote: (zone: string) => string;
	reschedule: string;
	cancel: string;
	calendarHint: string;
	footer: string;
}

const EN: BookingEmailCopy = {
	guestSubject: {
		confirmed: (title, host) => `Booked: ${title} with ${host}`,
		rescheduled: (title, host) => `Moved: ${title} with ${host}`,
		cancelled: (title, host) => `Cancelled: ${title} with ${host}`,
	},
	guestHeading: {
		confirmed: 'Your meeting is booked',
		rescheduled: 'Your meeting has moved',
		cancelled: 'Your meeting is cancelled',
	},
	guestIntro: {
		confirmed: (host) => `You booked a meeting with ${host}.`,
		rescheduled: (host) => `Your meeting with ${host} is at a new time.`,
		cancelled: (host) => `Your meeting with ${host} will not take place.`,
	},
	hostSubject: {
		confirmed: (title, guest) => `New booking: ${title} with ${guest}`,
		rescheduled: (title, guest) => `Moved: ${title} with ${guest}`,
		cancelled: (title, guest) => `Cancelled: ${title} with ${guest}`,
	},
	hostHeading: {
		confirmed: 'Someone booked a meeting with you',
		rescheduled: 'A booking has moved',
		cancelled: 'A booking was cancelled',
	},
	hostIntro: {
		confirmed: (guest) => `${guest} booked a meeting on your booking page.`,
		rescheduled: (guest) => `${guest} moved their meeting to a new time.`,
		cancelled: (guest) => `The meeting with ${guest} will not take place.`,
	},
	when: 'When',
	where: 'Where',
	videoLink: 'Video call',
	guestNote: 'Note',
	guest: 'Guest',
	timeZoneNote: (zone) => `Times are shown in ${zone}.`,
	reschedule: 'Pick another time',
	cancel: 'Cancel the meeting',
	calendarHint: 'The attached invite adds the meeting to your calendar.',
	footer: 'Sent by Owlat',
};

const DE: BookingEmailCopy = {
	guestSubject: {
		confirmed: (title, host) => `Gebucht: ${title} mit ${host}`,
		rescheduled: (title, host) => `Verschoben: ${title} mit ${host}`,
		cancelled: (title, host) => `Abgesagt: ${title} mit ${host}`,
	},
	guestHeading: {
		confirmed: 'Dein Termin ist gebucht',
		rescheduled: 'Dein Termin wurde verschoben',
		cancelled: 'Dein Termin ist abgesagt',
	},
	guestIntro: {
		confirmed: (host) => `Du hast einen Termin mit ${host} gebucht.`,
		rescheduled: (host) => `Dein Termin mit ${host} findet zu einer neuen Zeit statt.`,
		cancelled: (host) => `Dein Termin mit ${host} findet nicht statt.`,
	},
	hostSubject: {
		confirmed: (title, guest) => `Neue Buchung: ${title} mit ${guest}`,
		rescheduled: (title, guest) => `Verschoben: ${title} mit ${guest}`,
		cancelled: (title, guest) => `Abgesagt: ${title} mit ${guest}`,
	},
	hostHeading: {
		confirmed: 'Jemand hat einen Termin bei dir gebucht',
		rescheduled: 'Eine Buchung wurde verschoben',
		cancelled: 'Eine Buchung wurde abgesagt',
	},
	hostIntro: {
		confirmed: (guest) => `${guest} hat über deine Buchungsseite einen Termin gebucht.`,
		rescheduled: (guest) => `${guest} hat den Termin auf eine neue Zeit verschoben.`,
		cancelled: (guest) => `Der Termin mit ${guest} findet nicht statt.`,
	},
	when: 'Wann',
	where: 'Wo',
	videoLink: 'Videoanruf',
	guestNote: 'Notiz',
	guest: 'Gast',
	timeZoneNote: (zone) => `Zeiten in ${zone}.`,
	reschedule: 'Andere Zeit wählen',
	cancel: 'Termin absagen',
	calendarHint: 'Mit der angehängten Einladung landet der Termin in deinem Kalender.',
	footer: 'Gesendet von Owlat',
};

export const BOOKING_EMAIL_COPY: Record<AppLocale, BookingEmailCopy> = { en: EN, de: DE };
