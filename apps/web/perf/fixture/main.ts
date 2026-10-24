/**
 * The scenario page: mounts one scenario's real components into `#stage` and
 * exposes `window.__owlatPerf` (perf/fixtureApi.ts) to the runner.
 *
 * Each mount is its own Vue app with its own i18n instance, so unmounting it
 * releases everything the scenario created and the runner can count what is
 * left behind.
 */
import './autoImports';
import './style.css';
import { createApp, type App, type Component } from 'vue';
import { createI18n } from 'vue-i18n';
import { datetimeFormats, numberFormats } from '../../i18n/formats';
import type { FidelitySentinels, FixtureApi } from '../fixtureApi';
import { SCENARIOS, scenarioById, type Scenario } from '../scenarios';
import { counter, timing, type Sample } from '../stats';
import { assistantStream } from './assistantStream';
import { chatHistory } from './chatHistory';
import { registerComponents } from './components';
import { postboxList } from './postboxList';
import { teamInbox } from './teamInbox';
import { createProbe, nextFrame, sum, type Probe } from './probe';

/** A message catalog: nested keys down to message strings. */
interface Catalog {
	[key: string]: string | Catalog;
}
const catalogs = import.meta.glob<Catalog>(
	['../../i18n/locales/en.json', '../../../../packages/ui/i18n/locales/en.json'],
	{ eager: true, import: 'default' }
);
// The layer's `ui.*` catalog first and the app's last, as @nuxtjs/i18n merges them.
const en: Catalog = {
	...catalogs['../../../../packages/ui/i18n/locales/en.json'],
	...catalogs['../../i18n/locales/en.json'],
};

const stage = document.getElementById('stage') as HTMLElement;

const sentinels: FidelitySentinels = {
	vueErrors: [],
	unresolvedComponents: [],
	missingI18nKeys: [],
};
window.addEventListener('error', (event) => sentinels.vueErrors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) =>
	sentinels.vueErrors.push(String(event.reason))
);

/** A component Vue could not resolve renders as an element the browser does not know. */
function noteUnresolvedComponents() {
	for (const el of stage.querySelectorAll('*')) {
		const tag = el.tagName.toLowerCase();
		if (el instanceof HTMLUnknownElement && !sentinels.unresolvedComponents.includes(tag)) {
			sentinels.unresolvedComponents.push(tag);
		}
	}
}

type Run = (probe: Probe, stage: HTMLElement) => Promise<Sample>;

interface Built {
	Host: Component;
	rows: number;
	run: Run;
}

function build(scenario: Scenario): Built {
	switch (scenario.family) {
		case 'assistant-stream':
			return assistantStream(scenario);
		case 'chat-history':
			return chatHistory(scenario);
		case 'postbox-list':
			return postboxList(scenario);
		case 'team-inbox':
			return teamInbox(scenario);
	}
}

interface Mounted {
	app: App;
	probe: Probe;
	run: Run;
}
let current: Mounted | null = null;

const api: FixtureApi = {
	scenarioIds: SCENARIOS.map((s) => s.id),

	async mount(id) {
		if (current) throw new Error('a scenario is already mounted');
		const scenario = scenarioById(id);
		const built = build(scenario);
		const app = createApp(built.Host);
		app.config.errorHandler = (error) => sentinels.vueErrors.push(String(error));
		app.use(
			createI18n({
				legacy: false,
				locale: 'en',
				fallbackLocale: 'en',
				messages: { en },
				datetimeFormats,
				numberFormats,
				missing: (_locale, key) => {
					if (!sentinels.missingI18nKeys.includes(key)) sentinels.missingI18nKeys.push(key);
					return key;
				},
			})
		);
		registerComponents(app);
		const probe = createProbe(app, stage);

		const t0 = performance.now();
		app.mount(stage);
		await nextFrame();
		await nextFrame();
		const mountMs = performance.now() - t0;
		noteUnresolvedComponents();
		current = { app, probe, run: built.run };
		return {
			rows: counter(built.rows),
			'components mounted': counter(probe.live()),
			// The rendered DOM's size as the page sees it: unlike Chrome's own node
			// count, it does not move with the browser's internals.
			'elements rendered': counter(stage.querySelectorAll('*').length),
			'component updates during mount': counter(sum(probe.takeUpdates().values())),
			'mount to second frame': timing(mountMs),
		};
	},

	async run() {
		if (!current) throw new Error('no scenario is mounted');
		const sample = await current.run(current.probe, stage);
		noteUnresolvedComponents();
		return sample;
	},

	async unmount() {
		if (!current) throw new Error('no scenario is mounted');
		const { app, probe } = current;
		current = null;
		const t0 = performance.now();
		app.unmount();
		await nextFrame();
		const unmountMs = performance.now() - t0;
		const left = probe.live();
		probe.dispose();
		stage.replaceChildren();
		return {
			sample: {
				'components left mounted': counter(left),
				'unmount to next frame': timing(unmountMs),
			},
			sentinels: structuredClone(sentinels),
		};
	},
};

window.__owlatPerf = api;
