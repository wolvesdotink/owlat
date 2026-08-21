/**
 * The sending-readiness sentence. This is a COPY AUDIT: the whole point of the
 * surface is that an operator meets the ramp cap before pressing send, so the
 * assertions are about what each state is allowed to claim (deliverability plan
 * D14 — say exactly what is known):
 *   - a cap that could not be measured says nothing at all
 *   - a spent day is never rendered as "about 0 contacts"
 *   - a growth the projection does not show is never promised
 *   - an audience over today's cap is PACED, not failed
 *   - an uncounted audience is never rendered as an audience of zero
 */
import { describe, it, expect } from 'vitest';

import { sendReadinessNote, type ReadinessMessage, type SendingReadiness } from '../sendReadiness';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * The note is derived at module scope, so it hands back catalog keys; the copy
 * these tests audit is the English the catalog renders for them.
 */
const { t } = createTestI18n().global;
const text = (message: ReadinessMessage | null | undefined): string | null => {
	if (message === null || message === undefined) return null;
	return typeof message === 'string' ? t(message) : t(message.key, message.params ?? {});
};

/** Midday on Jan 5 UTC, so "tomorrow" is the Jan 6 UTC day start. */
const NOW = Date.UTC(2026, 0, 5, 12, 0);
const TOMORROW = Date.UTC(2026, 0, 6);
const IN_THREE_DAYS = Date.UTC(2026, 0, 8);

function capped(overrides: Partial<Extract<SendingReadiness, { capped: true }>> = {}) {
	return { capped: true as const, today: 500, growsTo: null, growsAt: null, ...overrides };
}

describe('sendReadinessNote — nothing is claimed without a measurement', () => {
	it('renders nothing before the query resolves', () => {
		expect(sendReadinessNote(undefined, { now: NOW })).toBeNull();
		expect(sendReadinessNote(null, { now: NOW })).toBeNull();
	});

	it.each(['dispatch_unknown', 'no_projection', 'measurement_failed'])(
		'renders nothing when capacity is unmeasured (%s)',
		(reason) => {
			expect(sendReadinessNote({ capped: false, reason }, { now: NOW })).toBeNull();
		}
	);

	it('reassures — without a number — when no cap applies to this send', () => {
		const overflow = sendReadinessNote(
			{ capped: false, reason: 'warmup_overflow_absorbs' },
			{ now: NOW }
		);
		expect(overflow?.tone).toBe('ready');
		expect(text(overflow?.headline)).toBe('No warm-up limit applies to this send');
		expect(text(overflow?.detail)).toContain('verified relay');

		const provider = sendReadinessNote({ capped: false, reason: 'not_own_mta' }, { now: NOW });
		expect(text(provider?.detail)).toContain('sending provider');
	});
});

describe('sendReadinessNote — the capped answer', () => {
	it('quotes today, before any audience is chosen', () => {
		const note = sendReadinessNote(capped({ today: 1500 }), { now: NOW });
		expect(note?.tone).toBe('ready');
		expect(text(note?.headline)).toBe('You can send to about 1,500 contacts today');
		expect(note?.detail).toBeNull();
	});

	it('reads as English at a capacity of one', () => {
		const note = sendReadinessNote(capped({ today: 1 }), { now: NOW });
		expect(text(note?.headline)).toBe('You can send to about 1 contact today');
	});

	it('treats an audience of zero as one nobody has counted yet', () => {
		// The wizard passes `count ?? 0` while its count query is in flight, and an
		// empty segment reads the same way. Neither is an audience that "fits".
		const loading = sendReadinessNote(capped({ today: 500 }), { audienceSize: 0, now: NOW });
		expect(loading?.tone).toBe('ready');
		expect(text(loading?.headline)).toBe('You can send to about 500 contacts today');
		expect(loading?.detail).toBeNull();
		expect(text(loading?.detail) ?? '').not.toContain('audience of 0');
	});

	it('says the audience fits when it does', () => {
		const note = sendReadinessNote(capped({ today: 500 }), { audienceSize: 500, now: NOW });
		expect(note?.tone).toBe('ready');
		expect(text(note?.detail)).toBe("Your audience of 500 fits in today's capacity.");
	});

	it('presents an over-cap audience as paced, never as a failure', () => {
		const note = sendReadinessNote(capped({ today: 500 }), { audienceSize: 2000, now: NOW });
		expect(note?.tone).toBe('paced');
		expect(text(note?.detail)).toContain('Your audience of 2,000 is larger');
		expect(text(note?.detail)).toContain('paced over the following days');
		// The refusal vocabulary belongs to nothing on this surface.
		expect((text(note?.headline) ?? '').toLowerCase()).not.toContain('cannot');
	});

	it('names tomorrow by name, and any later day by date', () => {
		const soon = sendReadinessNote(capped({ growsTo: 900, growsAt: TOMORROW }), { now: NOW });
		expect(text(soon?.detail)).toBe('Your capacity grows to about 900 tomorrow.');

		const later = sendReadinessNote(capped({ growsTo: 900, growsAt: IN_THREE_DAYS }), { now: NOW });
		// UTC, off the backend's own day anchor — never the viewer's zone.
		expect(text(later?.detail)).toBe('Your capacity grows to about 900 on Thu, Jan 8.');
	});

	it('names that later day in the locale it is given', () => {
		// The sentence is the catalog's, the numbers and the date inside it are
		// formatted here — so `SendReadinessNote.vue` hands the active locale down
		// and a German page never reads "Thu, Jan 8".
		const note = sendReadinessNote(capped({ growsTo: 900, growsAt: IN_THREE_DAYS }), {
			now: NOW,
			locale: 'de',
		});
		expect(text(note?.detail)).toContain('Do., 8. Jan.');
	});

	it('keeps the growth alongside the paced sentence', () => {
		const note = sendReadinessNote(capped({ today: 500, growsTo: 900, growsAt: TOMORROW }), {
			audienceSize: 2000,
			now: NOW,
		});
		expect(text(note?.detail)).toContain('paced over the following days');
		expect(text(note?.detail)).toContain('grows to about 900 tomorrow');
	});

	it('promises no growth the projection does not show', () => {
		const note = sendReadinessNote(capped({ today: 500 }), { audienceSize: 2000, now: NOW });
		expect(text(note?.detail)).not.toContain('grows');
	});
});

describe('sendReadinessNote — a spent day', () => {
	it('says the day is used up instead of quoting "about 0 contacts"', () => {
		const note = sendReadinessNote(capped({ today: 0 }), { audienceSize: 2000, now: NOW });
		expect(note?.tone).toBe('waiting');
		expect(text(note?.headline)).toBe("Today's sending capacity is used up");
		expect(text(note?.headline)).not.toContain('0 contacts');
	});

	it('names when it returns, or what to do when that is unknown', () => {
		const known = sendReadinessNote(capped({ today: 0, growsTo: 700, growsAt: TOMORROW }), {
			now: NOW,
		});
		expect(text(known?.detail)).toBe('Your capacity grows to about 700 tomorrow.');

		const unknown = sendReadinessNote(capped({ today: 0 }), { now: NOW });
		expect(text(unknown?.detail)).toContain('schedule the campaign');
	});
});
