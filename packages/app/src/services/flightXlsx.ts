import type { FlightResult } from '@online-openrocket/engine';
import type { UnitSelection } from '../prefs/units.js';
import { seriesColumns } from './flightDataCsv.js';
import { sheetsToXlsx, type Cell, type ChartSeriesSpec, type ChartSpec, type Sheet } from './xlsx.js';

/**
 * Flight-data Excel workbook (issue 2026-08-25, Eric's XLSX-with-graphs ask):
 * the same per-timestep columns as the flight-data CSV — the column specs and
 * unit mapping are IMPORTED from flightDataCsv, not duplicated — as typed
 * numeric cells under unit-labelled headers ("Altitude (ft)"), plus native
 * Excel chart tabs whose series reference the data sheet's cell ranges, so
 * editing the data re-draws the charts.
 *
 * EVERY EXPORTED COLUMN REACHES A CHART (2026-08-25b). Until then the workbook
 * charted three quantities — altitude, velocity, acceleration — because the
 * list mirrored the on-screen panel's default selection, while the data sheet
 * carried the friendly dozen plus every symbol-keyed series the kernel emits
 * (57 columns on a full-mode flight, measured 2026-08-25: the friendly 12
 * plus 45 symbol series). Eric: "why not give them charts for all the data
 * we are exporting?" So the chart set is now built from the columns that are
 * actually present:
 *   1. NAMED_CHARTS — one tab per headline quantity, in flight-panel order.
 *   2. GROUPED_CHARTS — themed multi-series tabs that collect the symbol
 *      columns, so the coefficient and rate families read as families instead
 *      of as thirty near-identical tabs.
 *   3. Anything still unclaimed gets its own tab, derived from its header.
 * Step 3 is the completeness guarantee, and it is why it is a RULE and not a
 * list: a future kernel FlightDataType lands in the export and gets a chart
 * without anyone remembering to add it here.
 *
 * A GROUP NEVER MIXES UNITS. Air temperature (K ~10²), pressure (Pa ~10⁵) and
 * density (kg/m³ ~10⁰) share a topic but not an axis; on one linear axis
 * density is a flat line on zero, which is a lie about the data. They stay
 * three tabs. The same test excluded Coriolis acceleration from the
 * accelerations group (~10⁻⁴ m/s² against a boost of ~10²) — same unit, but it
 * cannot be read next to Az, so it gets its own tab under rule 3. Wind
 * velocity is out of the velocity group for the same reason, and a subtler
 * one: flightDataCsv puts it in the `windspeed` unit group, which is mph
 * under imperial while the vehicle's own velocities are ft/s — same dimension,
 * different unit, so the axis label would have been a lie for one of them.
 *
 * Charts skip a column the flight does not carry, so a summary-mode run (which
 * emits only SUMMARY_SYMBOL_TYPES) produces proportionally fewer tabs.
 *
 * Staged flights get one data sheet per branch (branch 0 is the sustainer
 * stack — the same data as the top-level series). Each booster is a separate
 * flight with its own time base, so a shared row axis would misalign samples;
 * per-branch sheets keep every branch honest. The two chart kinds then differ:
 * a SINGLE-quantity tab carries one series per stage (color follows the stage
 * across every such tab, so a stage is the same color everywhere), while a
 * GROUPED tab splits per branch — "Drag coefficients — Booster" — because
 * members × branches on one plot is five colors times three stages and no
 * legend rescues that.
 *
 * The charts are Excel "X Y Scatter with straight lines" (c:scatterChart),
 * deliberately NOT c:lineChart: the kernel's RK4 timestep is adaptive —
 * measured on a real exported flight (docs/User files/testa-flight-data.csv):
 * 594 distinct dt values over 726 samples, 0.0025 s to 0.456 s — and a
 * lineChart's category axis spaces samples evenly, which would compress the
 * fine-stepped boost phase ~3.5× against the coarse-stepped descent. A
 * numeric time axis is the only honest rendering; markers are off (a
 * multi-thousand-point series with markers is unreadable).
 */

/**
 * Headline quantities, one tab each, in the order the flight panels show them
 * (FlightCharts) — the workbook opens on the same reading order as the screen
 * the user just left. Keys are the friendly column names from flightDataCsv.
 */
const NAMED_CHARTS: string[] = [
  'Altitude', 'Velocity', 'Acceleration', 'Mass', 'Thrust', 'Drag force',
  'Mach number', 'Stability margin', 'CP location', 'CG location', 'Angle of attack',
];

/**
 * Themed tabs for the symbol-keyed columns. `axis` labels the shared y-axis
 * (the unit is appended from whichever member the flight actually carries);
 * `members` are flightDataCsv symbol keys, and a member the flight lacks is
 * simply left out of its chart.
 *
 * Every group is single-unit by construction — see the module doc. The drag
 * group leads because it is the one family whose members are meant to be read
 * against each other: Cd is what Cdf, Cdp and Cdb add up to.
 */
const GROUPED_CHARTS: { tab: string; axis: string; members: string[] }[] = [
  { tab: 'Drag coefficients', axis: 'Coefficient', members: ['Cd', 'Cdf', 'Cdp', 'Cdb', 'Cda'] },
  { tab: 'Force & moment coeffs', axis: 'Coefficient', members: ['Cn', 'Cθ', 'CτΨ', 'Cτs', 'CτΦ'] },
  { tab: 'Damping coefficients', axis: 'Coefficient', members: ['CfΦ', 'CζΦ', 'Cζθ', 'CζΨ'] },
  { tab: 'Angular rates', axis: 'Rate', members: ['dΦ', 'dθ', 'dΨ'] },
  { tab: 'Orientation', axis: 'Angle', members: ['Θ', 'Φ', 'θl', 'θw'] },
  { tab: 'Position', axis: 'Distance', members: ['ha', 'Px', 'Py', 'Pl'] },
  { tab: 'Velocity components', axis: 'Velocity', members: ['Vz', 'Vl', 'Vs'] },
  { tab: 'Accelerations', axis: 'Acceleration', members: ['Az', 'Al', 'g'] },
  { tab: 'Moments of inertia', axis: 'Moment of inertia', members: ['Il', 'Ir'] },
  { tab: 'Latitude & longitude', axis: 'Degrees', members: ['φ', 'λ'] },
];

/**
 * Series colors. Single-quantity tabs on an unstaged flight take a slot by
 * chart order; staged flights color by STAGE instead (see module doc), and a
 * grouped tab colors by member. All three cycle the app's validated
 * categorical palette (chartTheme SERIES) so a workbook chart and the panel
 * the user just looked at use the same ink.
 */
const PALETTE = ['2A78D6', '1BAF7A', 'EDA100', '008300', '4A3AA7', 'E34948', 'E87BA4', 'EB6834'];

/**
 * Find a column by key. Headers are `${name} (${unit})` for the friendly
 * columns (or the bare name when dimensionless) and `${symbol} — ${name}
 * (${unit})` for symbol columns, so match the bare key, the "key (" prefix, or
 * the "key — " prefix. The separators are what keep near-misses apart: key
 * 'Cd' does not match 'Cda — …', and 'T' does not match 'Twr — …'.
 */
function colIndex(headers: string[], key: string): number {
  return headers.findIndex((h) => h === key || h.startsWith(`${key} (`) || h.startsWith(`${key} — `));
}

/** The unit a header carries, or '' — the text inside its final parentheses. */
function unitOf(header: string): string {
  const open = header.lastIndexOf(' (');
  return open > 0 && header.endsWith(')') ? header.slice(open + 2, -1) : '';
}

/** A header's plain quantity name: no `SYM — ` prefix, no ` (unit)` suffix. */
function quantityName(header: string): string {
  const dash = header.indexOf(' — ');
  const body = dash >= 0 ? header.slice(dash + 3) : header;
  const open = body.lastIndexOf(' (');
  return (open > 0 && body.endsWith(')') ? body.slice(0, open) : body).trim();
}

/**
 * A grouped tab's label, shortened so `${label} — ${branch}` survives Excel's
 * 31-character sheet-name cap with the BRANCH name intact.
 *
 * Which half to sacrifice is the whole decision. xlsx.ts's sanitize() slices
 * the tail at 31 and then de-duplicates, so letting it truncate ate the stage
 * name — the only thing distinguishing these tabs from each other. Measured
 * 2026-08-25 with the app's own default stage names: "Force & moment coeffs —
 * Sustain", "Damping coefficients — Sustaine", and on a three-stage rocket
 * "Force & moment coeffs — Booster" (that is Booster 2) collided with
 * Booster's tab and became "Force & moment coeffs — Boos_20", naming no stage
 * at all. The group label is recoverable from the chart title and the axis;
 * the stage name is not.
 *
 * A branch named so long that fewer than four characters are left for the
 * label keeps the label whole and lets sanitize() do what it will — there is
 * nothing useful left to choose between.
 */
function trimGroupTab(tab: string, branch: string): string {
  const room = 31 - ' — '.length - branch.length;
  return room >= 4 && tab.length > room ? tab.slice(0, room).trimEnd() : tab;
}

interface Branch {
  name: string;
  cols: { header: string; values: (number | null)[] }[];
}

/** Rows shared by an x/y pair on one branch; 0 when either column is missing. */
function pairRows(b: Branch, xCol: number, yCol: number): number {
  if (xCol < 0 || yCol < 0) return 0;
  return Math.min(b.cols[xCol]!.values.length, b.cols[yCol]!.values.length);
}

/** The whole flight as an .xlsx byte array (see module doc for the layout). */
export function flightXlsx(result: FlightResult, units?: UnitSelection): Uint8Array {
  const staged = (result.branches?.length ?? 0) >= 2;
  const branches: Branch[] = staged
    ? result.branches!.map((b) => ({ name: b.name, cols: seriesColumns(b.series, '', units) }))
    : [{ name: 'Flight data', cols: seriesColumns(result.series, '', units) }];

  const sheets: Sheet[] = branches.map((b) => {
    const rowCount = Math.max(0, ...b.cols.map((c) => c.values.length));
    const rows: Cell[][] = [];
    for (let i = 0; i < rowCount; i++) {
      // NaN samples (kernel: undefined at that step) become EMPTY cells, and
      // the charts render them as gaps (dispBlanksAs) — never as zeros.
      rows.push(b.cols.map((c) => {
        const v = c.values[i];
        return v == null || !Number.isFinite(v) ? null : v;
      }));
    }
    return { name: b.name, headers: b.cols.map((c) => c.header), rows };
  });

  const headersOf = branches.map((b) => b.cols.map((c) => c.header));
  const timeCols = headersOf.map((h) => colIndex(h, 'Time'));
  // Every column any branch put on a chart. Branch 0's header list drives the
  // rule-3 sweep (branches share a column set; a booster that carries fewer
  // still contributes to whatever charts its own columns support).
  const claimed = new Set<string>(['Time']);
  const charts: ChartSpec[] = [];

  /** One tab, one series per branch — the headline quantities. */
  const addNamedChart = (key: string, colorSlot: number) => {
    const series: ChartSeriesSpec[] = [];
    let xTitle = '';
    let yTitle = '';
    branches.forEach((b, bi) => {
      const yCol = colIndex(headersOf[bi]!, key);
      const n = pairRows(b, timeCols[bi]!, yCol);
      if (n < 2) return;
      if (!yTitle) {
        xTitle = headersOf[bi]![timeCols[bi]!]!;
        yTitle = headersOf[bi]![yCol]!;
      }
      series.push({
        name: staged ? b.name : headersOf[bi]![yCol]!,
        sheetIndex: bi,
        xCol: timeCols[bi]!,
        yCol,
        rowCount: n,
        color: PALETTE[(staged ? bi : colorSlot) % PALETTE.length]!,
      });
    });
    if (series.length === 0) return;
    claimed.add(key);
    charts.push({ name: quantityName(yTitle), title: yTitle, xTitle, yTitle, series });
  };

  /** One tab per branch, one series per member — the themed families. */
  const addGroupedChart = (def: { tab: string; axis: string; members: string[] }) => {
    branches.forEach((b, bi) => {
      const headers = headersOf[bi]!;
      const series: ChartSeriesSpec[] = [];
      let unit = '';
      def.members.forEach((key, mi) => {
        const yCol = colIndex(headers, key);
        const n = pairRows(b, timeCols[bi]!, yCol);
        if (n < 2) return;
        claimed.add(key);
        if (!unit) unit = unitOf(headers[yCol]!);
        series.push({
          name: quantityName(headers[yCol]!),
          sheetIndex: bi,
          xCol: timeCols[bi]!,
          yCol,
          rowCount: n,
          color: PALETTE[mi % PALETTE.length]!,
        });
      });
      if (series.length === 0) return;
      const yTitle = unit ? `${def.axis} (${unit})` : def.axis;
      charts.push({
        name: staged ? `${trimGroupTab(def.tab, b.name)} — ${b.name}` : def.tab,
        // The TITLE inside the chart has no length limit, so it keeps both
        // names in full even when the tab had to give something up.
        title: staged ? `${def.tab} — ${b.name}` : def.tab,
        xTitle: headers[timeCols[bi]!]!,
        yTitle,
        series,
      });
    });
  };

  NAMED_CHARTS.forEach((key, i) => addNamedChart(key, i));
  GROUPED_CHARTS.forEach(addGroupedChart);

  // Rule 3: every column still unclaimed gets its own tab, so nothing the
  // workbook exports is chart-less. Keyed on the SYMBOL (or friendly name)
  // rather than the full header, because the header carries a unit that moves
  // with the user's preferences while the key does not.
  headersOf[0]!.forEach((header, i) => {
    const dash = header.indexOf(' — ');
    const key = dash >= 0 ? header.slice(0, dash) : quantityName(header);
    if (claimed.has(key) || i === timeCols[0]) return;
    addNamedChart(key, charts.length);
  });

  return sheetsToXlsx(sheets, charts);
}
