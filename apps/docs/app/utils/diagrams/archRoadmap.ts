/**
 * Data for the `::arch-roadmap` diagram on the vision page: the four phases of
 * the roadmap runway.
 */

export interface Phase {
	id: number;
	label: string;
	status: 'active' | 'upcoming' | 'planned' | 'future';
	title: string;
	ships: string[];
	foundation: string;
	icon: string;
}

export const phases: Phase[] = [
	{
		id: 0,
		label: 'Now',
		status: 'active',
		title: 'Email & Agent Platform',
		ships: [
			'Email campaigns',
			'Transactional',
			'Automations',
			'Audiences',
			'Inbound + agent pipeline',
			'Verification queue',
			'Knowledge graph',
			'File system',
			'Team chat',
			'Multi-channel store',
			'Visualize agent',
			'Desktop app',
		],
		foundation: 'Shipped: sending, audiences, inbound processing, and the agent framework',
		icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
	},
	{
		id: 1,
		label: 'Next',
		status: 'upcoming',
		title: 'Wiring the Intelligence',
		ships: [
			'Automatic knowledge extraction',
			'True semantic retrieval',
			'File content indexing',
			'LLM-synthesized answers',
		],
		foundation: 'Connecting the built data layer to live extraction and retrieval',
		icon: 'M13 10V3L4 14h7v7l9-11h-7z',
	},
	{
		id: 2,
		label: 'Then',
		status: 'planned',
		title: 'Autonomy & Channels',
		ships: [
			'Per-category graduated autonomy',
			'Autonomy feedback loop',
			'Outbound SMS / WhatsApp',
			'End-to-end code-work',
		],
		foundation: 'Graduated trust and outbound on every channel',
		icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
	},
	{
		id: 3,
		label: 'Later',
		status: 'future',
		title: 'The Complete Vision',
		ships: [
			'Voice',
			'Cross-system integrations',
			'Relationship intelligence',
			'Unified per-contact view',
		],
		foundation: 'The complete vision',
		icon: 'M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2 2 0 01-2 2H5a2 2 0 01-2-2V5.25A2 2 0 015.25 3h13.5A2 2 0 0121 5.25z',
	},
];
