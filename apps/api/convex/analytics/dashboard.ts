import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import { getUserIdFromSession } from '../lib/sessionOrganization';
import { getCachedContactCount } from '../lib/contactCountHelpers';
import { countWithPagination } from '../lib/pagination';
import { readDailyStats } from '../lib/sendDailyStats';

// Get dashboard stats for the instance.
//
// Reads the last 30 rows of `sendDailyStats` (one row per UTC day, written
// by the Send lifecycle `daily_stats_bump` effect for both campaign and
// transactional sends). Pre-deepening this query did `campaigns.collect()`
// plus `transactionalSends.take(5000)` on every subscriber, which
// fan-out-invalidated on every send-lifecycle mutation — the dashboard
// was the hottest reactive read in the system.
export const getStats = authedQuery({
	args: {},
	handler: async (ctx) => {
		await getUserIdFromSession(ctx);

		let totalContacts = await getCachedContactCount(ctx);
		if (totalContacts === null) {
			totalContacts = await countWithPagination(ctx.db, 'contacts', 'by_created_at', (q) =>
				q
			);
		}

		// Read the last 30 days of daily roll-up stats, summed across write shards.
		// Bounded to 30 days × SHARD_COUNT small docs regardless of send volume.
		const daily = await readDailyStats(ctx.db, 30, Date.now());

		let emailsInLast30Days = 0;
		let totalDelivered = 0;
		let totalOpened = 0;
		let totalClicked = 0;
		for (const row of daily) {
			emailsInLast30Days += row.sent;
			totalDelivered += row.delivered;
			totalOpened += row.opened;
			totalClicked += row.clicked;
		}

		// Rate semantics match the prior shape: open/click over delivered,
		// mixing campaign + transactional on the same footing.
		const openRate = totalDelivered > 0 ? Math.round((totalOpened / totalDelivered) * 100) : 0;
		const clickRate = totalDelivered > 0 ? Math.round((totalClicked / totalDelivered) * 100) : 0;

		return {
			totalContacts,
			emailsInLast30Days,
			openRate,
			clickRate,
		};
	},
});

// Get recent activity for the dashboard
// Combines audit logs (organization actions) and contact activities (email events)
export const getRecentActivity = authedQuery({
	args: {
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		const limit = args.limit ?? 10;

		// Get recent audit logs (organization member actions)
		const auditLogs = await ctx.db
			.query('auditLogs')
			.order('desc')
			.take(limit);

		// Get recent contact activities (email events)
		const contactActivities = await ctx.db
			.query('contactActivities')
			.order('desc')
			.take(limit);

		// Convert to unified activity format
		type ActivityItem = {
			id: string;
			type: string;
			description: string;
			timestamp: number;
			icon: 'email' | 'contact' | 'campaign' | 'settings' | 'automation' | 'list';
		};

		const activities: ActivityItem[] = [];

		// Process audit logs
		for (const log of auditLogs) {
			const description = formatAuditLogDescription(log);
			if (description) {
				activities.push({
					id: log._id,
					type: log.action,
					description,
					timestamp: log.createdAt,
					icon: getIconForResource(log.resource),
				});
			}
		}

		// Process contact activities - focus on email events
		for (const activity of contactActivities) {
			// Get contact details for display
			const contact = await ctx.db.get(activity.contactId);
			const contactName = contact
				? contact.firstName || contact.email?.split('@')[0] || 'User'
				: 'Unknown';

			const description = formatContactActivityDescription(activity, contactName);
			if (description) {
				activities.push({
					id: activity._id,
					type: activity.activityType,
					description,
					timestamp: activity.occurredAt,
					icon: getIconForActivityType(activity.activityType),
				});
			}
		}

		// Sort by timestamp descending and take the limit
		activities.sort((a, b) => b.timestamp - a.timestamp);
		return activities.slice(0, limit);
	},
});

// Helper to format audit log descriptions
function formatAuditLogDescription(log: {
	action: string;
	resource: string;
	details?: unknown;
}): string | null {
	const details = (log.details as Record<string, unknown>) ?? {};
	const name = details['name'] || '';

	switch (log.action) {
		case 'campaign.created':
			return name ? `Created campaign "${name}"` : 'Created a new campaign';
		case 'campaign.sent':
			return name ? `Sent campaign "${name}"` : 'Sent a campaign';
		case 'campaign.scheduled':
			return name ? `Scheduled campaign "${name}"` : 'Scheduled a campaign';
		case 'contact.created':
			return name ? `Added contact ${name}` : 'Added a new contact';
		case 'contact.imported':
			return details['count'] ? `Imported ${details['count']} contacts` : 'Imported contacts';
		case 'email_template.created':
			return name ? `Created email template "${name}"` : 'Created an email template';
		case 'email_template.published':
			return name ? `Published email template "${name}"` : 'Published an email template';
		case 'automation.created':
			return name ? `Created automation "${name}"` : 'Created an automation';
		case 'automation.activated':
			return name ? `Activated automation "${name}"` : 'Activated an automation';
		case 'topic.created':
			return name ? `Created topic "${name}"` : 'Created a topic';
		case 'settings.updated':
			return 'Updated organization settings';
		case 'team_member.invited':
			return details['email']
				? `Invited ${details['email']} to the organization`
				: 'Invited an organization member';
		default:
			return null; // Skip less important actions
	}
}

// Helper to format contact activity descriptions
function formatContactActivityDescription(
	activity: { activityType: string; metadata?: unknown },
	contactName: string
): string | null {
	const metadata = (activity.metadata as Record<string, unknown>) ?? {};

	switch (activity.activityType) {
		case 'email_sent':
			return metadata['emailSubject']
				? `Email "${metadata['emailSubject']}" sent to ${contactName}`
				: `Email sent to ${contactName}`;
		case 'email_opened':
			return metadata['emailSubject']
				? `${contactName} opened "${metadata['emailSubject']}"`
				: `${contactName} opened an email`;
		case 'email_clicked':
			return `${contactName} clicked a link in an email`;
		case 'created':
			return `${contactName} was added as a contact`;
		case 'subscribed':
			return `${contactName} subscribed`;
		case 'unsubscribed':
			return `${contactName} unsubscribed`;
		case 'topic_subscribed':
			return metadata['topicName']
				? `${contactName} subscribed to "${metadata['topicName']}"`
				: `${contactName} subscribed to a topic`;
		default:
			return null; // Skip less important activities
	}
}

// Helper to get icon type for resource
function getIconForResource(
	resource: string
): 'email' | 'contact' | 'campaign' | 'settings' | 'automation' | 'list' {
	switch (resource) {
		case 'campaign':
			return 'campaign';
		case 'contact':
			return 'contact';
		case 'email_template':
			return 'email';
		case 'automation':
			return 'automation';
		case 'topic':
			return 'list';
		default:
			return 'settings';
	}
}

// Helper to get icon type for activity type
function getIconForActivityType(
	activityType: string
): 'email' | 'contact' | 'campaign' | 'settings' | 'automation' | 'list' {
	switch (activityType) {
		case 'email_sent':
		case 'email_opened':
		case 'email_clicked':
		case 'email_bounced':
			return 'email';
		case 'topic_subscribed':
		case 'topic_unsubscribed':
			return 'list';
		case 'created':
		case 'subscribed':
		case 'unsubscribed':
			return 'contact';
		default:
			return 'settings';
	}
}
