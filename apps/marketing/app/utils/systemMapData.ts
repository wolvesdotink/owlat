/* Layout + timeline data for SystemMapSection's animated architecture map.
 * Split out so the SVG component stays under the file-size cap.
 *
 * Geometry and timing only — the copy lives in i18n/locales/*.json under
 * `systemMap.*` and is referenced here by full message key, so a translator
 * never has to touch this file and the catalog guard test can see the keys.
 *
 * Every label is grounded in shipped features: campaigns/automations/
 * transactional API (README feature table), the built-in outbound MTA
 * (README architecture), DKIM/SPF/DMARC verification (README), and the
 * ramp controller driven by bounce/complaint/engagement/placement signals
 * (docs/developer/deliverability-infrastructure, docs/developer/providers). */

export type MapNode = {
	id: string;
	/** Message key for the node's title. */
	labelKey: string;
	/** Message key for the node's caption. */
	subKey: string;
	x: number;
	y: number;
	w: number;
	h: number;
	/** Beat on which the node first ignites. */
	beat: number;
	/** Beats (besides `beat`) on which the node re-ignites. */
	reigniteBeats?: number[];
};

export type MapEdge = {
	id: string;
	/** Beat during which this edge draws itself. */
	beat: number;
	/** SVG path data (drawn from source to target). */
	d: string;
	/** Return-path edges render in the gold accent instead of terracotta. */
	ret?: boolean;
};

export type MapBeat = {
	id: string;
	/** Message key for the chip's title. */
	labelKey: string;
	/** Message key for the chip's one-line explanation. */
	captionKey: string;
};

export const VIEW_W = 960;
export const VIEW_H = 440;

export const BEAT_MS = 2000;

export const MAP_NODES: MapNode[] = [
	{
		id: 'campaigns',
		labelKey: 'systemMap.nodes.campaigns.label',
		subKey: 'systemMap.nodes.campaigns.sub',
		x: 40,
		y: 48,
		w: 150,
		h: 50,
		beat: 0,
	},
	{
		id: 'automations',
		labelKey: 'systemMap.nodes.automations.label',
		subKey: 'systemMap.nodes.automations.sub',
		x: 40,
		y: 126,
		w: 150,
		h: 50,
		beat: 0,
	},
	{
		id: 'api',
		labelKey: 'systemMap.nodes.api.label',
		subKey: 'systemMap.nodes.api.sub',
		x: 40,
		y: 204,
		w: 150,
		h: 50,
		beat: 0,
	},
	{
		id: 'mta',
		labelKey: 'systemMap.nodes.mta.label',
		subKey: 'systemMap.nodes.mta.sub',
		x: 330,
		y: 112,
		w: 170,
		h: 78,
		beat: 0,
		reigniteBeats: [4],
	},
	{
		id: 'auth',
		labelKey: 'systemMap.nodes.auth.label',
		subKey: 'systemMap.nodes.auth.sub',
		x: 590,
		y: 117,
		w: 170,
		h: 68,
		beat: 1,
	},
	{
		id: 'inbox',
		labelKey: 'systemMap.nodes.inbox.label',
		subKey: 'systemMap.nodes.inbox.sub',
		x: 830,
		y: 123,
		w: 92,
		h: 56,
		beat: 2,
	},
	{
		id: 'signals',
		labelKey: 'systemMap.nodes.signals.label',
		subKey: 'systemMap.nodes.signals.sub',
		x: 600,
		y: 330,
		w: 200,
		h: 62,
		beat: 3,
	},
	{
		id: 'ramp',
		labelKey: 'systemMap.nodes.ramp.label',
		subKey: 'systemMap.nodes.ramp.sub',
		x: 290,
		y: 330,
		w: 190,
		h: 62,
		beat: 4,
	},
];

export const MAP_EDGES: MapEdge[] = [
	{ id: 'campaigns-mta', beat: 0, d: 'M190 73 C 260 73, 264 132 330 138' },
	{ id: 'automations-mta', beat: 0, d: 'M190 151 L 330 151' },
	{ id: 'api-mta', beat: 0, d: 'M190 229 C 260 229, 264 170 330 164' },
	{ id: 'mta-auth', beat: 1, d: 'M500 151 L 590 151' },
	{ id: 'auth-inbox', beat: 2, d: 'M760 151 L 830 151' },
	{ id: 'inbox-signals', beat: 3, d: 'M876 179 C 876 250, 850 361 800 361', ret: true },
	{ id: 'signals-ramp', beat: 4, d: 'M600 361 L 480 361', ret: true },
	{ id: 'ramp-mta', beat: 4, d: 'M385 330 C 385 262, 398 230 408 190', ret: true },
];

export const MAP_BEATS: MapBeat[] = [
	{
		id: 'send',
		labelKey: 'systemMap.beats.send.label',
		captionKey: 'systemMap.beats.send.caption',
	},
	{
		id: 'authenticate',
		labelKey: 'systemMap.beats.authenticate.label',
		captionKey: 'systemMap.beats.authenticate.caption',
	},
	{
		id: 'deliver',
		labelKey: 'systemMap.beats.deliver.label',
		captionKey: 'systemMap.beats.deliver.caption',
	},
	{
		id: 'measure',
		labelKey: 'systemMap.beats.measure.label',
		captionKey: 'systemMap.beats.measure.caption',
	},
	{
		id: 'adapt',
		labelKey: 'systemMap.beats.adapt.label',
		captionKey: 'systemMap.beats.adapt.caption',
	},
];
