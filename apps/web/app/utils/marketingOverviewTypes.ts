import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';

/** The Marketing overview's single read (`analytics.marketingOverview.get`). */
export type MarketingOverview = FunctionReturnType<typeof api.analytics.marketingOverview.get>;
export type LatestCampaign = MarketingOverview['latest'][number];
export type RecentCampaigns = MarketingOverview['recent'];
export type MarketingPeriod = MarketingOverview['period'];
export type MarketingDelivery = MarketingOverview['delivery'];
