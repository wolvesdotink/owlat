/**
 * Data for the `::arch-verification-queue` diagram on the vision page: the
 * sample queue items and the stats bar.
 */

export const queueItems = [
	{
		id: 1,
		type: 'email',
		typeLabel: 'Email Reply',
		icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
		subject: 'Re: Booking reschedule request',
		from: 'Sarah Chen',
		confidence: 94,
		confidenceLevel: 'high',
		time: '12s ago',
		status: 'auto-approved',
	},
	{
		id: 2,
		type: 'email',
		typeLabel: 'Email Reply',
		icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
		subject: 'Re: Billing dispute — double charge',
		from: 'Marcus Rivera',
		confidence: 67,
		confidenceLevel: 'medium',
		time: '2m ago',
		status: 'review',
	},
	{
		id: 3,
		type: 'ticket',
		typeLabel: 'Ticket',
		icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
		subject: 'Feature request: bulk export contacts',
		from: 'Internal — Product',
		confidence: 82,
		confidenceLevel: 'high',
		time: '5m ago',
		status: 'review',
	},
	{
		id: 4,
		type: 'code',
		typeLabel: 'Code Change',
		icon: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
		subject: 'PR #847: Add CSV export endpoint',
		from: 'Coding Agent',
		confidence: 41,
		confidenceLevel: 'low',
		time: '8m ago',
		status: 'review',
	},
];

export const stats = [
	{ label: 'Pending', value: '3', color: 'brand' },
	{ label: 'Auto-approved today', value: '24', color: 'success' },
	{ label: 'Avg response', value: '8s', color: 'info' },
];

export type QueueItem = (typeof queueItems)[number];
