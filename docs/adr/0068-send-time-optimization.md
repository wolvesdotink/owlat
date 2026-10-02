# ADR-0068: Send-time optimization — a decayed hour histogram per contact, a holdout to prove it

## Status

Accepted.

## Context

Campaigns could go out at one instant for everyone, or at one wall-clock time
in each recipient's time zone. Neither uses what Owlat already observes: when
each contact actually reads its mail. The data is there (the first reader open
and the first reader click of every campaign send), but opens are noisy. Apple
Mail Privacy Protection fetches the pixel on delivery, security gateways fetch
it to scan it, and some opens arrive by provider webhook with no way to tell
who fetched them. A model fed those fetches would learn the delivery time, not
the reading time.

Sending each contact at a different hour also has to live with the machinery
that already owns throughput: the multi-day send plan, the ramp ceilings and
the deliverability gates on the governed enqueue path.

## Decision

### 1. The profile: two decayed marginal histograms per contact

Each contact carries an optional `sendTimeProfile` on its row: 24 local-hour
weights, 7 local-weekday weights, their total, the instant they are "as of",
and the IANA zone they were bucketed in. Not a 168-cell hour-of-week grid: a
contact engages a few times a month, so the grid would be almost empty, while
the hour histogram fills up after a handful of events and the weekday
histogram only tilts the choice when a window spans days.

Every event's weight halves every 60 days. Because decayed sums stay
exponential, folding an event is O(1) (decay to the event, add it), and an
event older than the profile's instant is added already decayed, which gives
the same result as folding in order. A click weighs 2, an open 1.

What is folded: the first reader click of a campaign send, and its first
reader open when our own pixel classified the client as a mail client (not
Apple's proxy, not a scanner) and it came after the 5-second prefetch window.
Provider-reported opens carry no client class and are left out. Only campaign
mail counts; transactional opens follow the action that triggered them.

The profile lives on the contact row rather than in a table of its own, so
contact erasure removes it with the contact, the contact data export carries
it, and the send walker reads it off the contacts the audience page already
loaded.

### 2. The organization histogram: random shards

The same events also land, bucketed in the same local slot, on a random shard
of `sendTimeHistogramShards` (8 shards, the `campaignStatShards` idiom). The
planner sums the shards. Both writes happen in one scheduled mutation, not in
the send lifecycle's transaction, so an open wave contending on a shard never
retries the transition itself. The shards hold aggregate weights only; the
workspace deletion sweep removes them.

### 3. The planner proposes; the send pipeline still decides

"Optimized per contact" takes a start, a window (1–72 hours, 24 by default)
and a comparison share (0–50 %, 10 by default). For each contact, in order:

1. the comparison group (a deterministic hash of campaign and contact) goes at
   the start;
2. a contact whose decayed evidence is at least 3 gets the candidate hour its
   profile scores highest (lightly smoothed hour weight times weekday weight),
   read in the profile's zone;
3. otherwise the organization histogram, once its evidence is at least 20,
   read in the contact's zone;
4. otherwise the start's wall-clock time in the contact's zone, if that falls
   inside the window, else the start.

Candidates are the start and every local top of the hour before the window
closes. The walker schedules the enqueue for each proposed instant; the
enqueue then goes through the governed path like any other, so pacing, ramp
ceilings and gates apply at that moment. A page resolved after part of the
window has passed plans only into the hours still ahead. When the multi-day
plan imposes a day budget, the window ends with that UTC day, so a day's slice
never spills into the next day's capacity. A walk resumed after its window
closed gets a fresh window from the resume.

A/B tests cannot be optimized: spreading the test cohort over a day would
change what the winner is measured on. The scheduling mutations refuse the
combination, and refuse it together with "send at recipient's local time".

### 4. The report compares against the holdout, not against history

An optimized send carries `emailSends.sendTimeGroup`. Its delivered, first
reader open and first reader click bump per-arm counters in the same shard
write as the campaign's own counters. An open or click only counts for its arm
within 24 hours of that send going out, and the report waits until 24 hours
after the last send (or after the window's end, whichever is later): the
holdout goes out at the start and would otherwise have had up to a whole
window longer to collect opens. The report shows the two groups' open and
click rates per delivered email and only calls a difference when a
two-proportion z-test puts it beyond chance at 95 %, and only once each group
has 100 delivered emails. Without a comparison group it says there is nothing
to compare. Comparing against earlier campaigns would mix the timing effect
with the content, the audience and the season.

### 5. Existing history: migration 0064

`0064_backfill_send_time_profiles` walks contacts, rebuilds each profile from
its latest 60 campaign sends, and rebuilds the organization histogram from the
same events. It counts opens and clicks only from campaigns that already
filtered automated ones (`isAutomatedOpenFiltered` /
`isAutomatedClickFiltered`); earlier campaigns may hold proxy fetches. A send
row does not record whether its first open came from our pixel or from a
provider webhook, so the backfill takes `openedAt` either way, unlike live
learning, which skips provider-reported opens. Profiles are rebuilt, not added
to, so a page can be redone; a fresh pass clears the organization shards
first.

## Consequences

- No feature flag: the option is a per-campaign choice, needs no service or
  secret, and costs one scheduled mutation per reader engagement.
- The predicted distribution in the schedule panel plans the audience's first
  page (1,000 recipients) and presents a larger audience as a sample.
- Out of scope: optimizing automation sends, and models beyond the histogram.
