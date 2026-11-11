/**
 * The ops dashboard's metric definitions: one entry for every tile and section on it, kept in one place. The wording is in the
 * ops app's message files under `defs.<id>` (`definition`, `numerator`, `denominator`) in both languages; this list says what each
 * entry measures in terms the server can be checked against: the response fields its numerator and denominator are read from,
 * the period it answers for and how it is suppressed. A test fails when a tile has no entry, when an entry has no wording in both
 * languages, and when an entry names a field the metric route does not return. `docs/metric-definitions.md` is generated from
 * this list and the English and Arabic wording (`pnpm docs:metrics`) and is checked against them.
 */

/** The metric routes a definition reads its figures from, and the response each returns. */
export const METRIC_ROUTES = ['/metrics/funnel', '/metrics/timeliness', '/metrics/crisis', '/metrics/equity', '/metrics/outcomes', '/adverse-events'] as const;
export type MetricRoute = (typeof METRIC_ROUTES)[number];

/** One field of a route's response, by dotted path. A path goes through arrays and through the `{ suppressed: true }` alternative without naming them. */
export interface MetricField {
  route: MetricRoute;
  path: string;
}

/**
 * The period a figure answers for:
 *  - `selected`: the period chosen at the top of the dashboard;
 *  - `equity90`: always the last 90 days (the equity view's one period), whatever is chosen;
 *  - `now`: how things stand at this moment, not tied to a period;
 *  - `log`: the whole adverse-events log, whatever is chosen.
 */
export type MetricPeriodKind = 'selected' | 'equity90' | 'now' | 'log';

/**
 * How the figure is kept from naming a small group: `shares` (a share needs its part, its whole and what is left over at 10 or
 * more), `counts` (a count under 10 is hidden), `funnel`, `equity` and `outcomes` (the cells of one table are hidden together, so
 * none can be worked out from the others), `list` (shown only at 10 or more) and `log` (an incident log: no person in it, so
 * nothing to suppress).
 */
export type MetricSuppressionKind = 'shares' | 'counts' | 'funnel' | 'equity' | 'outcomes' | 'list' | 'log';

export interface MetricDefinition {
  /** The tile's or the section's id on the dashboard (`data-tile` / `data-section`, or `overdue` for the list inside timeliness). */
  id: string;
  /** The ops message key of the figure's name on the dashboard, from the root of the message file; the generated document titles it with that. */
  label: string;
  surface: 'tile' | 'section';
  period: MetricPeriodKind;
  /** What the figure counts or measures, as response fields. */
  numerator: readonly MetricField[];
  /** What it is a share of, as response fields; empty when the figure is not a share. */
  denominator: readonly MetricField[];
  suppression: MetricSuppressionKind;
}

export const METRIC_DEFINITIONS = [
  {
    id: 'loop-closed',
    label: 'dash.tiles.loopClosed',
    surface: 'tile',
    period: 'equity90',
    numerator: [{ route: '/metrics/equity', path: 'overall.loopClosed' }],
    denominator: [{ route: '/metrics/equity', path: 'overall.tickets' }],
    suppression: 'shares',
  },
  {
    id: 'within-target',
    label: 'dash.tiles.withinTarget',
    surface: 'tile',
    period: 'selected',
    numerator: [{ route: '/metrics/timeliness', path: 'overall.withinTarget.count' }],
    denominator: [{ route: '/metrics/timeliness', path: 'overall.withinTarget.of' }],
    suppression: 'shares',
  },
  {
    id: 'median-seen',
    label: 'dash.tiles.medianSeen',
    surface: 'tile',
    period: 'selected',
    numerator: [
      { route: '/metrics/timeliness', path: 'overall.medianDaysToSeen' },
      { route: '/metrics/timeliness', path: 'overall.p90DaysToSeen' },
    ],
    denominator: [],
    suppression: 'counts',
  },
  {
    id: 'crisis-contact',
    label: 'dash.tiles.crisisContact',
    surface: 'tile',
    period: 'selected',
    numerator: [{ route: '/metrics/crisis', path: 'contactConfirmed.count' }],
    denominator: [{ route: '/metrics/crisis', path: 'contactConfirmed.of' }],
    suppression: 'shares',
  },
  {
    id: 'funnel',
    label: 'dash.funnel.heading',
    surface: 'section',
    period: 'selected',
    numerator: [{ route: '/metrics/funnel', path: 'stages.count' }],
    denominator: [{ route: '/metrics/funnel', path: 'stages.count' }],
    suppression: 'funnel',
  },
  {
    id: 'equity',
    label: 'dash.equity.heading',
    surface: 'section',
    period: 'equity90',
    numerator: [{ route: '/metrics/equity', path: 'dimensions.rows.cell.loopClosed' }],
    denominator: [{ route: '/metrics/equity', path: 'dimensions.rows.cell.tickets' }],
    suppression: 'equity',
  },
  {
    id: 'timeliness',
    label: 'dash.timeliness.heading',
    surface: 'section',
    period: 'selected',
    numerator: [{ route: '/metrics/timeliness', path: 'tiers.cell.withinTarget.count' }],
    denominator: [{ route: '/metrics/timeliness', path: 'tiers.cell.withinTarget.of' }],
    suppression: 'shares',
  },
  {
    id: 'overdue',
    label: 'dash.timeliness.overdueHeading',
    surface: 'section',
    period: 'now',
    numerator: [{ route: '/metrics/timeliness', path: 'overdue.count' }],
    denominator: [],
    suppression: 'list',
  },
  {
    id: 'safety',
    label: 'dash.safety.heading',
    surface: 'section',
    period: 'selected',
    numerator: [
      { route: '/metrics/crisis', path: 'calledALine.count' },
      { route: '/metrics/crisis', path: 'contactConfirmed.count' },
    ],
    denominator: [
      { route: '/metrics/crisis', path: 'shown' },
      { route: '/metrics/crisis', path: 'calledALine.of' },
    ],
    suppression: 'shares',
  },
  {
    id: 'outcomes',
    label: 'dash.outcomes.heading',
    surface: 'section',
    period: 'selected',
    numerator: [
      { route: '/metrics/outcomes', path: 'instruments.reliableImprovement.count' },
      { route: '/metrics/outcomes', path: 'instruments.reliableDeterioration.count' },
      { route: '/metrics/outcomes', path: 'instruments.meanChange' },
    ],
    denominator: [{ route: '/metrics/outcomes', path: 'instruments.reliableImprovement.of' }],
    suppression: 'outcomes',
  },
  {
    id: 'adverse-events',
    label: 'adverse.heading',
    surface: 'section',
    period: 'log',
    numerator: [
      { route: '/adverse-events', path: 'counts.byStatus.open' },
      { route: '/adverse-events', path: 'counts.byStatus.investigating' },
      { route: '/adverse-events', path: 'counts.byStatus.closed' },
      { route: '/adverse-events', path: 'counts.bySeverity.critical' },
    ],
    denominator: [],
    suppression: 'log',
  },
] as const satisfies readonly MetricDefinition[];

export type MetricDefinitionId = (typeof METRIC_DEFINITIONS)[number]['id'];
