import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookMeeting, fetchManagedBooking, fetchMeetingPage } from '../bookingClient';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		json: async () => ({ ok: true, data: {} }),
	});
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: { convexSiteUrl: 'https://owlat.convex.site' },
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function calledUrl(): string {
	return String(fetchMock.mock.calls[0]![0]);
}

describe('bookingClient', () => {
	it('asks for a page slug the way it is stored, whatever case the link was typed in', async () => {
		await fetchMeetingPage('Ada', 'intro', { from: 1, until: 2 });
		expect(calledUrl()).toBe(
			'https://owlat.convex.site/booking/page/ada?type=intro&from=1&until=2'
		);
	});

	it('books on the lowercase slug', async () => {
		await bookMeeting('ADA', { type: 'intro', start: 1, name: 'Grace', email: 'g@example.com' });
		expect(calledUrl()).toBe('https://owlat.convex.site/booking/book/ada');
	});

	it('leaves a manage token exactly as it came', async () => {
		await fetchManagedBooking('bk_AbC123');
		expect(calledUrl()).toBe('https://owlat.convex.site/booking/manage/bk_AbC123');
	});
});
