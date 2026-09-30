/**
 * Undo-send policy contract: the windows the backend accepts and the window it
 * holds a send for when none is given both come from `@owlat/shared/undoSendPolicy`,
 * the module the web control and composer read too.
 *
 * The composer expresses the default window by sending no `undoSendDelayMs` at
 * all, so a backend default that drifted from the web one would count down one
 * window and hold for another; a validator that drifted would reject a choice
 * the settings page offers. The web half of the join — the offered options and
 * the offline-queue window are the shared values — is pinned in
 * `apps/web/app/utils/__tests__/postboxUndoSendWindow.test.ts`, because nothing
 * in `apps/api` may import a web module.
 */

import { DEFAULT_UNDO_SEND_SECONDS, UNDO_SEND_SECOND_CHOICES } from '@owlat/shared/undoSendPolicy';
import { describe, expect, it } from 'vitest';
import { mailUndoSendSecondsValidator } from '../../lib/validators/mailSettings';
import { DEFAULT_UNDO_SEND_DELAY_MS } from '../draftLifecycle/types';

describe('undo-send policy contract', () => {
	it('validates the stored preference against exactly the shared choices, in order', () => {
		const literals = mailUndoSendSecondsValidator.members.map((member) => member.value);
		expect(literals).toEqual([...UNDO_SEND_SECOND_CHOICES]);
	});

	it('keeps the stored values existing mailUserSettings rows and callers already use', () => {
		// These numbers are persisted in `mailUserSettings.undoSendSeconds`; a
		// change here is a schema migration, not a refactor.
		expect([...UNDO_SEND_SECOND_CHOICES]).toEqual([0, 10, 30, 60]);
	});

	it('holds an unspecified send for the shared default window, in milliseconds', () => {
		expect(DEFAULT_UNDO_SEND_DELAY_MS).toBe(DEFAULT_UNDO_SEND_SECONDS * 1_000);
	});

	it('defaults to a window the settings control actually offers', () => {
		expect(UNDO_SEND_SECOND_CHOICES).toContain(DEFAULT_UNDO_SEND_SECONDS);
		expect(DEFAULT_UNDO_SEND_SECONDS).toBe(10);
	});
});
