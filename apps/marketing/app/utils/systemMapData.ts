/* Layout + timeline data for SystemMapSection's animated architecture map.
 * Split out so the SVG component stays under the file-size cap.
 *
 * Every label is grounded in shipped features: campaigns/automations/
 * transactional API (README feature table), the built-in outbound MTA
 * (README architecture), DKIM/SPF/DMARC verification (README), and the
 * ramp controller driven by bounce/complaint/engagement/placement signals
 * (docs/developer/deliverability-infrastructure, docs/developer/providers). */

export type MapNode = {
	id: string;
	label: string;
	sub: string;
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
	label: string;
	caption: string;
};

export const VIEW_W = 960;
export const VIEW_H = 440;

export const BEAT_MS = 2000;

export const MAP_NODES: MapNode[] = [
	{
		id: 'campaigns',
		label: 'Campaigns',
		sub: 'Scheduled sends',
		x: 40,
		y: 48,
		w: 150,
		h: 50,
		beat: 0,
	},
	{
		id: 'automations',
		label: 'Automations',
		sub: 'Trigger flows',
		x: 40,
		y: 126,
		w: 150,
		h: 50,
		beat: 0,
	},
	{ id: 'api', label: 'API', sub: 'Transactional', x: 40, y: 204, w: 150, h: 50, beat: 0 },
	{
		id: 'mta',
		label: 'Owlat MTA',
		sub: 'SMTP engine',
		x: 330,
		y: 112,
		w: 170,
		h: 78,
		beat: 0,
		reigniteBeats: [4],
	},
	{
		id: 'auth',
		label: 'Authentication',
		sub: 'DKIM · SPF · DMARC',
		x: 590,
		y: 117,
		w: 170,
		h: 68,
		beat: 1,
	},
	{ id: 'inbox', label: 'Inbox', sub: 'Recipients', x: 830, y: 123, w: 92, h: 56, beat: 2 },
	{
		id: 'signals',
		label: 'Signals',
		sub: 'Bounce · Engagement · Placement',
		x: 600,
		y: 330,
		w: 200,
		h: 62,
		beat: 3,
	},
	{
		id: 'ramp',
		label: 'Ramp controller',
		sub: 'Reputation & pacing',
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
	{ label: 'Send', caption: 'Campaigns, automations and API sends queue on the MTA' },
	{ label: 'Authenticate', caption: 'Every message is signed and aligned: DKIM, SPF, DMARC' },
	{ label: 'Deliver', caption: 'The built-in MTA hands off to recipient inboxes over SMTP' },
	{ label: 'Measure', caption: 'Bounces, engagement and placement stream back as signals' },
	{ label: 'Adapt', caption: 'The ramp controller adjusts sending share and pacing' },
];
