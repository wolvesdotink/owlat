/**
 * Data for the `::arch-agent-pipeline` walkthrough on the Vision page: the five
 * steps an agent runs for one incoming message, each with the example output
 * the detail panel shows.
 *
 * Lives beside the components rather than inside them so the walkthrough's
 * copy can be read and edited without scrolling past the layout CSS.
 */

export type AgentPipelineColor = 'accent' | 'info' | 'warning' | 'brand' | 'success';

/**
 * One pipeline step. `num` picks which step-specific field the detail panel
 * renders: 1 `sources`, 2 `intents`, 3 `actions`, 4 `draft`, 5 `routes`.
 */
export interface AgentPipelineStep {
	num: number;
	name: string;
	detail: string;
	/** `d` attribute of a single 24×24 stroked path. */
	icon: string;
	color: AgentPipelineColor;
	example: string;
	sources?: string[];
	intents?: { label: string; active: boolean }[];
	actions?: { label: string; type: 'api' | 'draft' | 'data' }[];
	draft?: { subject: string; preview: string };
	routes?: { label: string; desc: string; primary?: boolean }[];
}

export const agentPipelineSteps: AgentPipelineStep[] = [
	{
		num: 1,
		name: 'Context Retrieval',
		detail: 'Query the Knowledge Graph',
		icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
		color: 'accent',
		sources: ['Customer history', 'Account data', 'Past interactions', 'Org policies'],
		example: 'Retrieves booking #4821, customer profile, Thursday availability data',
	},
	{
		num: 2,
		name: 'Classification',
		detail: 'Determine intent & urgency',
		icon: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z',
		color: 'info',
		intents: [
			{ label: 'Booking change', active: true },
			{ label: 'Billing', active: false },
			{ label: 'Complaint', active: false },
			{ label: 'Feature request', active: false },
		],
		example: 'Intent: booking change · Urgency: normal · Sentiment: neutral',
	},
	{
		num: 3,
		name: 'Action Planning',
		detail: 'Decide what to do',
		icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01',
		color: 'warning',
		actions: [
			{ label: 'Fetch Saturday availability', type: 'api' },
			{ label: 'Draft confirmation email', type: 'draft' },
			{ label: 'Update booking record', type: 'data' },
		],
		example: 'Plan: check availability → draft reschedule confirmation → queue for review',
	},
	{
		num: 4,
		name: 'Draft Generation',
		detail: 'Produce grounded response',
		icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
		color: 'brand',
		draft: {
			subject: 'Re: Booking reschedule request',
			preview: 'Hi Sarah, your booking has been moved to Saturday at 10am...',
		},
		example: 'Uses org tone, includes booking details, Saturday confirmed available',
	},
	{
		num: 5,
		name: 'Routing',
		detail: 'Deliver or queue for review',
		icon: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6',
		color: 'success',
		routes: [
			{ label: 'Verification Queue', desc: 'Human reviews draft', primary: true },
			{ label: 'Auto-deliver', desc: 'High confidence, policy allows' },
		],
		example: 'Confidence: 92% · Routed to support queue · Assigned to agent on shift',
	},
];
