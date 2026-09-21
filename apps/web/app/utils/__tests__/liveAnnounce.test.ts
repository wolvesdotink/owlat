// @vitest-environment happy-dom
/**
 * The three rules behind the app's live region. All of them are about what a
 * screen reader SAYS, so none of them is visible in a screenshot or catchable
 * by a mounted-component assertion — they only exist as these tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	announcedPageLabel,
	distinctAnnouncement,
	normalizeAnnouncement,
	RE_ANNOUNCE_MARK,
	shouldMoveFocusToMain,
} from '../liveAnnounce';

describe('normalizeAnnouncement', () => {
	it('collapses the whitespace a template indentation leaves behind', () => {
		expect(normalizeAnnouncement('\n\t\tSaved\n\t\tContacts\n\t')).toBe('Saved Contacts');
	});

	it('is empty for a whitespace-only message', () => {
		expect(normalizeAnnouncement('  \n\t ')).toBe('');
	});
});

describe('distinctAnnouncement', () => {
	it('writes a new message through unchanged', () => {
		expect(distinctAnnouncement('', 'Done: Save signature')).toBe('Done: Save signature');
	});

	it('marks a REPEATED message so the region announces it again', () => {
		// The case that matters: saving the same form twice. Identical DOM text is
		// not a change, and a live region that does not change is silent.
		const first = distinctAnnouncement('', 'Done: Save signature');
		const second = distinctAnnouncement(first, 'Done: Save signature');
		expect(second).not.toBe(first);
		expect(second).toBe(`Done: Save signature${RE_ANNOUNCE_MARK}`);
	});

	it('alternates rather than growing without bound', () => {
		let current = '';
		const seen = new Set<string>();
		for (let i = 0; i < 10; i++) {
			const next = distinctAnnouncement(current, 'Done: Save signature');
			expect(next).not.toBe(current);
			seen.add(next);
			current = next;
		}
		// Ten identical saves, two distinct strings — the mark is toggled, not
		// appended ten times.
		expect(seen.size).toBe(2);
		expect(current.length).toBeLessThanOrEqual('Done: Save signature'.length + 1);
	});

	it('clears the region for an empty message instead of announcing a blank', () => {
		expect(distinctAnnouncement('Done: Save signature', '   ')).toBe('');
	});
});

describe('announcedPageLabel', () => {
	it('takes the last crumb — the page itself, not its section', () => {
		expect(
			announcedPageLabel([
				{ label: 'shared.breadcrumbRoutes.sections.audience' },
				{ label: 'shared.breadcrumbRoutes.pages.contacts' },
			])
		).toBe('shared.breadcrumbRoutes.pages.contacts');
	});

	it('passes a dynamic crumb (a contact name) through as-is', () => {
		expect(announcedPageLabel([{ label: 'Audience' }, { label: 'Ines Weber' }])).toBe('Ines Weber');
	});

	it('announces nothing rather than inventing a name for an empty trail', () => {
		expect(announcedPageLabel([])).toBeNull();
		expect(announcedPageLabel([{ label: '   ' }])).toBeNull();
	});
});

describe('shouldMoveFocusToMain', () => {
	function render(html: string): void {
		document.body.innerHTML = html;
	}

	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('moves focus when the page navigated with focus on nothing', () => {
		// Where the browser leaves focus after the element that had it unmounted.
		expect(shouldMoveFocusToMain(null)).toBe(true);
		render('<main id="main-content"></main>');
		expect(shouldMoveFocusToMain(document.body)).toBe(true);
	});

	it('moves focus off a rail link the person just activated', () => {
		render('<nav><a id="rail" href="/dashboard/audience">Audience</a></nav>');
		expect(shouldMoveFocusToMain(document.getElementById('rail'))).toBe(true);
	});

	it('moves focus out of the header chrome too', () => {
		render('<header><button id="search">Search</button></header>');
		expect(shouldMoveFocusToMain(document.getElementById('search'))).toBe(true);
	});

	it('LEAVES focus where a route change is the interaction', () => {
		// Arrowing down the Postbox thread list changes the route on every row.
		// Yanking focus to <main> each time would make the list unusable.
		render('<main id="main-content"><ul><li><a id="row">Quarterly numbers</a></li></ul></main>');
		expect(shouldMoveFocusToMain(document.getElementById('row'))).toBe(false);
	});

	it('leaves focus on a surviving control outside the chrome', () => {
		render('<div><button id="dock">Compose</button></div>');
		expect(shouldMoveFocusToMain(document.getElementById('dock'))).toBe(false);
	});
});
