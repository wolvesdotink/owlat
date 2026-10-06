// @vitest-environment happy-dom
/**
 * PostboxInviteCard — where the invite's iCalendar text comes from (plan 3.5).
 *
 * The card used to download the whole raw `.eml` on every mount to read a few
 * KB of text/calendar. Delivery now cuts that part out on its own, so:
 *   - a stored invite renders without the raw message being fetched at all;
 *   - `absent` (the message has no text/calendar part) renders nothing and
 *     fetches nothing;
 *   - `unknown` (older mail, parts not cut yet) and a failed action both fall
 *     back to the raw `.eml`, as before.
 *
 * An RSVP opens the composer with the generated `reply.ics` in the compose
 * request itself (plain text that survives a reload), not in memory (#1257).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

import PostboxInviteCard from '../PostboxInviteCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const ICS = [
	'BEGIN:VCALENDAR',
	'METHOD:REQUEST',
	'BEGIN:VEVENT',
	'SUMMARY:Quarterly planning',
	'DTSTART:20261001T090000Z',
	'DTEND:20261001T100000Z',
	'ORGANIZER;CN=Bob:mailto:bob@example.com',
	'END:VEVENT',
	'END:VCALENDAR',
].join('\r\n');

const RAW_EML = [
	'From: bob@example.com',
	'Content-Type: multipart/mixed; boundary="bb"',
	'',
	'--bb',
	'Content-Type: text/calendar; method=REQUEST',
	'',
	ICS.replace('Quarterly planning', 'From the raw message'),
	'--bb--',
	'',
].join('\r\n');

let calendarAnswer: () => Promise<unknown>;
const composeOpen = vi.fn();
const loadRawEml = vi.fn(async (_id: string) => RAW_EML as string | null);

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePostboxComposeNav', () => ({ open: composeOpen }));
	vi.stubGlobal('loadRawEml', (id: string) => loadRawEml(id));
	vi.stubGlobal('requireConvex', () => ({ action: () => calendarAnswer() }));
});

beforeEach(() => {
	loadRawEml.mockClear();
	composeOpen.mockClear();
	calendarAnswer = async () => ({ status: 'found', ics: ICS });
});

async function mountCard() {
	const w = mount(PostboxInviteCard, {
		props: { messageId: 'msg-1', mailboxId: 'mbx-1', ownEmail: 'alice@example.com' },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, UiButton: { template: '<button><slot /></button>' } },
		},
	});
	await flushPromises();
	return w;
}

describe('PostboxInviteCard', () => {
	it('renders the stored invite without downloading the raw message', async () => {
		const w = await mountCard();

		expect(w.text()).toContain('Quarterly planning');
		expect(loadRawEml).not.toHaveBeenCalled();
	});

	it('renders nothing and fetches nothing for a message with no calendar part', async () => {
		calendarAnswer = async () => ({ status: 'absent' });
		const w = await mountCard();

		expect(w.text()).toBe('');
		expect(loadRawEml).not.toHaveBeenCalled();
	});

	it('reads the raw message for mail stored before parts were', async () => {
		calendarAnswer = async () => ({ status: 'unknown' });
		const w = await mountCard();

		expect(loadRawEml).toHaveBeenCalledWith('msg-1');
		expect(w.text()).toContain('From the raw message');
	});

	it('falls back to the raw message when the stored read fails', async () => {
		calendarAnswer = async () => {
			throw new Error('offline for a moment');
		};
		const w = await mountCard();

		expect(loadRawEml).toHaveBeenCalledWith('msg-1');
		expect(w.text()).toContain('From the raw message');
	});

	it('hands the generated RSVP to the composer inside the compose request', async () => {
		const w = await mountCard();
		const accept = w.findAll('button').find((b) => b.text().includes('Accept'));
		await accept!.trigger('click');

		expect(composeOpen).toHaveBeenCalledOnce();
		const spec = composeOpen.mock.calls[0]![0] as Record<string, unknown>;
		expect(spec).toMatchObject({ mailboxId: 'mbx-1', prefillTo: ['bob@example.com'] });
		expect(spec).not.toHaveProperty('attachPendingKey');
		// The request is stored as JSON: the file must come through that whole.
		const stored = JSON.parse(JSON.stringify(spec)) as typeof spec;
		expect(stored['attachGenerated']).toEqual({
			filename: 'reply.ics',
			contentType: 'text/calendar; method=REPLY; charset=utf-8',
			content: expect.stringContaining('METHOD:REPLY'),
		});
		expect((stored['attachGenerated'] as { content: string }).content).toContain(
			'PARTSTAT=ACCEPTED'
		);
	});
});
