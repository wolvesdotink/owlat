/**
 * Data for the `::arch-knowledge-graph` diagram on the vision page: one
 * customer's knowledge subgraph, the retrieval strategies and the briefing the
 * agent receives.
 */

type NodeType = 'fact' | 'decision' | 'event' | 'preference' | 'goal';

interface GraphNode {
	id: number;
	type: NodeType;
	label: string;
	detail: string;
	x: number;
	y: number;
}

export const nodes: GraphNode[] = [
	{
		id: 0,
		type: 'fact',
		label: 'Pro Plan',
		detail: 'Customer since 2024',
		x: 42,
		y: 16,
	},
	{
		id: 1,
		type: 'decision',
		label: 'Billing exception',
		detail: 'Credited $50 on Feb 12',
		x: 12,
		y: 44,
	},
	{
		id: 2,
		type: 'event',
		label: 'Upgrade to Pro',
		detail: 'January 2025',
		x: 88,
		y: 28,
	},
	{
		id: 3,
		type: 'preference',
		label: 'Prefers email',
		detail: 'Over phone or chat',
		x: 12,
		y: 80,
	},
	{
		id: 4,
		type: 'event',
		label: '3 support tickets',
		detail: 'Last 30 days — API rate limits',
		x: 88,
		y: 72,
	},
	{
		id: 5,
		type: 'goal',
		label: 'Reduce response time',
		detail: 'Target: under 2 hours',
		x: 50,
		y: 58,
	},
];

export const edges = [
	{ from: 0, to: 1 },
	{ from: 0, to: 2 },
	{ from: 0, to: 3 },
	{ from: 0, to: 4 },
	{ from: 1, to: 2 },
	{ from: 2, to: 4 },
	{ from: 3, to: 5 },
	{ from: 4, to: 5 },
];

export const typeConfig: Record<
	NodeType,
	{ color: string; colorVar: string; icon: string; label: string }
> = {
	fact: {
		color: 'brand',
		colorVar: '--color-brand',
		icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
		label: 'Fact',
	},
	decision: {
		color: 'accent',
		colorVar: '--color-accent',
		icon: 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4',
		label: 'Decision',
	},
	event: {
		color: 'info',
		colorVar: '--color-info',
		icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
		label: 'Event',
	},
	preference: {
		color: 'warning',
		colorVar: '--color-warning',
		icon: 'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z',
		label: 'Preference',
	},
	goal: {
		color: 'success',
		colorVar: '--color-success',
		icon: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6',
		label: 'Goal',
	},
};

export const retrievalMethods = [
	{
		name: 'Semantic Search',
		icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
		example: '"billing frustration"',
		detail: 'Vector similarity — finds conceptually related knowledge',
	},
	{
		name: 'Full-text Search',
		icon: 'M4 6h16M4 12h8m-8 6h16',
		example: '"invoice #12345"',
		detail: 'Exact keyword matching for specific records',
	},
	{
		name: 'Graph Traversal',
		icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
		example: '"all interactions with Acme Corp"',
		detail: 'Follow relationships across the graph',
	},
];

export const briefing =
	'Customer X has been on the Pro plan since 2024, upgraded in January. Billing exception granted in February ($50 credit). Prefers email. 3 recent tickets about API rate limits.';
