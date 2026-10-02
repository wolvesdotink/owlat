/**
 * Feature-gated function builders for the booking page (`calendar.booking`).
 *
 * They compose the org-member auth floor with the flag, so the host-facing
 * settings and bookings handlers in `booking/**` never repeat the flag check.
 * Every row those handlers touch is keyed by the caller's own user id; that
 * self-scope is the authorization, stated per handler.
 *
 * The guest-facing reads and writes are `internal*` functions behind the public
 * HTTP routes (`booking/publicHttp.ts`), which check the flag themselves and
 * answer "not found" while it is off.
 */

import { authedMutation, authedQuery, featureGated } from '../lib/authedFunctions';

export const bookingQuery = featureGated(authedQuery, 'calendar.booking');
export const bookingMutation = featureGated(authedMutation, 'calendar.booking');
