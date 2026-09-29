import { describe, it, expect } from 'vitest';
import { api } from '@owlat/api';
import { fakeLocalStore } from './fakeLocalStore';
import { optimisticUpdateSettings } from '../settingsUpdater';

/* eslint-disable @typescript-eslint/no-explicit-any -- the updater's args are loosely built here */

const get = api.mail.settings.get;
const run = (fake: ReturnType<typeof fakeLocalStore>, args: any) =>
	optimisticUpdateSettings(fake.store, args);

describe('optimisticUpdateSettings', () => {
	it('writes the switched preference over the cached row', () => {
		const fake = fakeLocalStore();
		fake.seed(get, {}, { autoAdvance: 'next', density: 'comfortable' });
		run(fake, { density: 'compact', readingPane: undefined });
		expect(fake.get(get, {})).toEqual({ autoAdvance: 'next', density: 'compact' });
	});

	it('starts a row for a user who never saved one', () => {
		const fake = fakeLocalStore();
		fake.seed(get, {}, null);
		run(fake, { markReadPolicy: 'manual' });
		expect(fake.get(get, {})).toEqual({ markReadPolicy: 'manual' });
	});

	it('does nothing while the settings are still loading', () => {
		const fake = fakeLocalStore();
		run(fake, { density: 'compact' });
		expect(fake.get(get, {})).toBeUndefined();
	});
});
