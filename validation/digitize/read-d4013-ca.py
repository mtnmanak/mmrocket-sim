"""Read the fins-on C_A,corr curves of NASA TN D-4013 Figures 11 and 12, and check them a second way.

Source: Ferris, NASA TN D-4013 (1967), NTRS
https://ntrs.nasa.gov/api/citations/19670020050/downloads/19670020050.pdf
(64-page scan, no text layer). Not committed - fetch it and pass its path:

    python validation/digitize/read-d4013-ca.py <path to 19670020050.pdf> [<forum Fig 11 png> <forum Fig 12 png>]

The two optional images are the TRF reproductions of the same two figures (a different scan,
834x1125 and 884x1125); with them the script reads the curves a third time.

Prints, for the Short (Fig 11, PDF page 62) and Long (Fig 12, PDF page 63) models, the delta_F = 0
(solid), delta_F = 2 (dashed) and fins-off (dash-dot) C_A,corr curves at every 0.05 Mach from
M0.60 to M1.20, then the independent route below. The `cd-transonic-tunnel` series in anchors.json
carry the delta_F = 0 reads; the fins-off reads are printed only as a calibration check against the
`cd0-finsoff-tunnel` anchors, which an earlier pipeline read off the same pages on 2026-08-25.

METHOD 1 - the summary curve (Figs 11 and 12, middle panel):
- Mach axis: the 17 printed vertical gridlines M0.50..1.30, found as near-full-height ink columns
  inside the panel; they are vertical to < 1.2 px over the panel, so x maps to Mach alone.
- C_A,corr axis: the panel's printed horizontal gridlines (0.80..0.00, every 0.05) where the figure
  draws them (Fig 11 over M <= 0.67 only, Fig 12 over M >= 0.95 only) plus the zero axis, which runs
  the full width. On these scans the horizontal lines are NOT parallel: their slope changes with
  height (Fig 11: about -3 px per 1000 px at the top of the panel, -10 at the zero axis). So the fit
  is per-line offset + a slope that varies linearly with line height, and a point's value is
  interpolated between the two fitted lines bracketing it at its own column. The alternative the
  2026-08-25 fins-off read used - one common slope for every line - is also computed and its
  difference reported as the de-skew term of the uncertainty.
- The curves: traced column by column from M0.60 to M1.20; printed vertical gridline columns are
  skipped. The solid delta_F = 0 curve is followed as an unbroken stroke (trace_continuous): each
  column's run must touch the last, and where two runs touch (the strokes merged at a crossing) the
  one nearest the linear prediction is tried first; a path that then breaks away from any gridline
  was the dashed stroke, and the trace backs up and takes the other run. This is what separates the
  solid curve from the dashed one where they cross (Fig 11 near M0.95, Fig 12 near M0.93 and at the
  peak): line style alone cannot. The dashed and dash-dot curves are followed by prediction across
  their gaps (trace), never taking a run that lies on the traced solid curve; a run of <= 4 px on a
  drawn horizontal gridline is taken only when no other run is near.
- The read at a gridline Mach (every target lies under a printed vertical line) is a quadratic fit
  to the traced centres within +/-0.011 Mach either side, evaluated at the line.
- Uncertainty, per point: RSS of the gridline-fit rms, the straightness of the drawn lines (the
  zero axis' rms about a straight line), the de-skew term, half the difference between a left-only
  and a right-only extrapolation to the gridline, and the Mach-axis fit residual times the local
  slope.

METHOD 2 - an independent route through two other figures (summary data at alpha = 0):
  C_A,corr = C_A - C_A,b,  C_A,b = -C_p,b x A_b/S,  A_b/S = 0.4225
- C_A at alpha = 0 from Fig 7(a) (Short; PDF pages 22-23) and Fig 9(a) (Long; pages 41-42): the
  report's own measured points, not its summary curve.
- C_p,b at alpha = 0 from Fig 3 (Short; pages 14-15) and Fig 5 (Long; pages 18-19).
- A_b/S = 0.4225 is the Fig 1(b) tail-cone base, 0.65 d; the 2026-08-25 pass showed -C_p,b x 0.4225
  reproduces the Fig 11/12 C_A,b panel to <= 0.004 (scorecard-finsoff-figs-2026-08-25.md 4.2).
- Each panel's value axis comes from its own printed gridlines (snapped near alpha = 0 and fitted).
  The symbols at alpha = 0 are read as a cluster: the ink rows in a +/-16 px band about the alpha = 0
  line that stand above that line's own ink, inside a value window that holds only the fins-on (or
  only the fins-off) symbols; the read is the cluster's mid-height. At alpha = 0 the three fins-on
  symbols (roll 0, 22.5, 45 deg) are repeat measurements of one flow, so their spread is part of
  the read's uncertainty, which is printed as half the cluster height above one symbol's height.
- Only the Mach numbers the report tested exist here: 0.60, 0.80, 0.90, 0.95 (Short), 1.00, 1.20.
- Its uncertainty adds the 0.004 of the C_p,b -> C_A,b conversion to the two symbol reads.
- Calibration: the same route applied to the fins-off symbols must reproduce the fins-off
  anchors read off Figs 11/12; it does to within +/-0.006 (printed).

DECISION (printed last): each delta_F = 0 read against the value gated until 2026-10-11. A point is
REPLACEd where the read differs from it by more than the read's uncertainty (never taken below the
0.004 digitization term of the fins-off tolerance budget) and a second method - the TRF image or
method 2 - agrees within the RSS of the two uncertainties.
"""
import sys

import numpy as np
import pymupdf
from PIL import Image

MACHS17 = [0.5 + 0.05 * i for i in range(17)]
TARGETS = [round(0.6 + 0.05 * i, 2) for i in range(13)]
VALS17 = [round(0.8 - 0.05 * k, 2) for k in range(17)]
FINSOFF_ANCHOR = {
    'Short': {0.6: 0.2214, 0.8: 0.2309, 0.9: 0.2611, 0.95: 0.2930, 1.0: 0.4174, 1.2: 0.4297},
    'Long': {0.6: 0.2491, 0.8: 0.2520, 0.9: 0.2663, 1.0: 0.3665, 1.2: 0.4219},
}

# Summary-figure panels. y0/y1: the C_A,corr panel rows used to find the vertical gridlines;
# vx0/vx1: approximate x of the M0.50 and M1.30 lines; ytop/yzero: approximate y of the 0.80 line and
# the zero axis; spans: x ranges where the figure draws its horizontal gridlines (the zero axis is
# always fitted over the full panel); win: half-height of the search band for a gridline;
# seeds: C_A,corr of each curve at M0.60, to start the trace; thresh: ink threshold (0-255); skip: columns
# of dropout bridged on the solid curve (the TRF images carry blank bands up to 5 px wide).
SUMMARY = {
    'report': {
        'Short': dict(page=62, y0=930, y1=2080, vx0=612, vx1=1790, ytop=930.5, yzero=2082, spans=[(560, 880)],
                      win=9, seeds={'solid': 0.300, 'dashed': 0.325, 'finsoff': 0.2214}, thresh=128, skip=2),
        'Long': dict(page=63, y0=915, y1=1990, vx0=586, vx1=1711, ytop=912.5, yzero=1992.5, spans=[(1220, 1712)],
                     win=7, seeds={'solid': 0.347, 'dashed': 0.356, 'finsoff': 0.2491}, thresh=128, skip=2),
    },
    'forum': {
        'Short': dict(page=None, y0=305, y1=815, vx0=205, vx1=728, ytop=300, yzero=817, spans=[(195, 330)],
                      win=5, seeds={'solid': 0.300, 'dashed': 0.325, 'finsoff': 0.2214}, thresh=150, skip=6),
        'Long': dict(page=None, y0=320, y1=805, vx0=222, vx1=741, ytop=315, yzero=811, spans=[(515, 742)],
                     win=5, seeds={'solid': 0.347, 'dashed': 0.356, 'finsoff': 0.2491}, thresh=150, skip=6),
    },
}

# Method-2 panels: (pdf page, x of the alpha = 0 line, y of the panel's zero line, px per unit value,
# value step between printed gridlines, gridlines above zero, gridlines below zero,
# {Mach: (fins-on value window, fins-off value window)}).
CA_PANELS = {
    'Short': [(22, 708, 917, 935, 0.1, 6, 0, {0.6: ((0.235, 0.30), (0.17, 0.225))}),
              (22, 708, 1565, 935, 0.1, 6, 0, {0.8: ((0.255, 0.33), (0.165, 0.23))}),
              (22, 708, 2398.5, 935, 0.1, 8, 0, {0.9: ((0.36, 0.46), (0.19, 0.28))}),
              (23, 819, 941, 767.5, 0.1, 8, 0, {0.95: ((0.50, 0.61), (0.24, 0.34))}),
              (23, 819, 1639.4, 767.5, 0.1, 8, 0, {1.0: ((0.65, 0.77), (0.35, 0.45))}),
              (23, 819, 2337, 767.5, 0.1, 8, 0, {1.2: ((0.59, 0.70), (0.41, 0.51))})],
    'Long': [(41, 764, 906, 788, 0.1, 8, 0, {0.6: ((0.275, 0.35), (0.19, 0.26))}),
             (41, 764, 1614, 788, 0.1, 8, 0, {0.8: ((0.29, 0.37), (0.19, 0.26))}),
             (41, 764, 2321.5, 788, 0.1, 8, 0, {0.9: ((0.39, 0.49), (0.18, 0.28))}),
             (42, 755, 1313, 967, 0.1, 10, 0, {1.0: ((0.69, 0.79), (0.29, 0.39))}),
             (42, 755, 2378.5, 967, 0.1, 10, 0, {1.2: ((0.60, 0.71), (0.37, 0.47))})],
}
CPB_PANELS = {
    'Short': [(14, 860, 447.5, 1468, 0.05, 2, 8, {0.6: ((0.080, 0.13), (0.03, 0.080))}),
              (14, 860, 1034.5, 1468, 0.05, 2, 8, {0.8: ((0.07, 0.13), (0.04, 0.13))}),
              (14, 860, 1768, 1468, 0.05, 2, 8, {0.9: ((0.0, 0.06), (0.06, 0.11))}),
              (15, 835, 434, 1462, 0.05, 2, 8, {0.95: ((-0.02, 0.035), (0.03, 0.07))}),
              (15, 835, 1311, 1462, 0.05, 2, 8, {1.0: ((-0.07, -0.01), (0.0, 0.05))}),
              (15, 835, 2041, 1462, 0.05, 0, 6, {1.2: ((-0.14, -0.08), (-0.08, -0.03))})],
    'Long': [(18, 756, 461, 1848, 0.05, 2, 8, {0.6: ((0.075, 0.13), (0.03, 0.075))}),
             (18, 756, 1570, 1848, 0.05, 2, 8, {0.8: ((0.088, 0.13), (0.06, 0.088))}),
             (19, 793, 513, 1466, 0.05, 2, 8, {0.9: ((0.02, 0.07), (0.08, 0.13))}),
             (19, 793, 1246, 1466, 0.05, 2, 8, {1.0: ((-0.06, 0.0), (0.02, 0.08))}),
             (19, 793, 1978, 1466, 0.05, 2, 6, {1.2: ((-0.10, -0.04), (-0.03, 0.03))})],
}
A_B_OVER_S = 0.4225
C_AB_CONVERSION = 0.004  # -C_p,b x 0.4225 against the Fig 11/12 C_A,b panel, worst of six (finsoff-figs 4.2)
DIGITIZATION_FLOOR = 0.004  # the fins-off tolerance budget's digitization term: four-read spread at M0.60
DUMP = None  # a directory to save the traced curves to (for overlay checks); None saves nothing
# The cd-transonic-tunnel values gated until 2026-10-11 (read in 2026-08 off the TN D-4013 curves as
# reproduced in Rogers' RASAero comparison deck, validation-anchors-2026-08-03.md 1.3); the table at the
# end compares the new read against them.
GATED_BEFORE = {
    'Short': {0.6: 0.295, 0.7: 0.300, 0.8: 0.309, 0.9: 0.350, 0.95: 0.46, 1.0: 0.683, 1.05: 0.685, 1.1: 0.666,
              1.15: 0.635, 1.2: 0.596},
    'Long': {0.6: 0.348, 0.7: 0.348, 0.8: 0.353, 0.9: 0.385, 0.95: 0.47, 1.0: 0.63, 1.05: 0.72, 1.1: 0.735,
             1.15: 0.665, 1.2: 0.635},
}
SYMBOL_PX = 22  # height of one plotted symbol on these pages (a fins-off circle reads 16-28 px)


def page_bitmap(doc, pno, thresh=128):
    pix = pymupdf.Pixmap(doc, doc[pno - 1].get_images(full=True)[0][0])
    img = Image.frombytes('L' if pix.n == 1 else 'RGB', (pix.width, pix.height), pix.samples)
    return np.array(img.convert('L')) < thresh


def png_bitmap(path, thresh):
    return np.array(Image.open(path).convert('L')) < thresh


def runs_in(col, lo, hi):
    idx = np.nonzero(col[lo:hi])[0] + lo
    runs = []
    for y in idx:
        if runs and y - runs[-1][-1] <= 1:
            runs[-1].append(y)
        else:
            runs.append([y])
    return [(r[0], r[-1]) for r in runs]


def vertical_gridlines(a, y0, y1, vx0, vx1):
    """The 17 Mach gridlines: each snapped to the column of most ink within +/-6 px of its nominal x."""
    cnt = a[y0:y1].sum(0).astype(float)
    out = []
    for xn in np.linspace(vx0, vx1, 17):
        xs = np.arange(int(xn) - 6, int(xn) + 7)
        c = cnt[xs]
        top = xs[c >= 0.5 * c.max()]
        out.append(np.average(top, weights=cnt[top]))
    return np.array(out)


def horizontal_grid(a, vx, ytop, yzero, spans, win, x_full, slope_model):
    """Fit the 17 C_A,corr gridlines. slope_model 'trend': slope varies linearly with line height;
    'common': one slope for every line (the 2026-08-25 de-skew)."""
    noms = np.linspace(ytop, yzero, 17)
    pts = []
    for k, yn in enumerate(noms):
        yn = int(round(yn))
        for xa, xb in (spans if k < 16 else [x_full]):
            for x in range(int(xa), int(xb)):
                if np.min(np.abs(vx - x)) <= 4:
                    continue
                idx = np.nonzero(a[yn - win:yn + win + 1, x])[0]
                if 1 <= len(idx) <= 6 and idx.max() - idx.min() <= 5:
                    pts.append((x, yn - win + idx.mean(), k, yn))
    pts = np.array(pts)
    ycen = noms.mean()
    for _ in range(8):
        cols = 18 if slope_model == 'trend' else 17
        D = np.zeros((len(pts), cols + 1))
        D[np.arange(len(pts)), pts[:, 2].astype(int)] = 1
        D[:, 17] = pts[:, 0]
        if slope_model == 'trend':
            D[:, 18] = pts[:, 0] * (pts[:, 3] - ycen) / 1000
        sol, *_ = np.linalg.lstsq(D, pts[:, 1], rcond=None)
        resid = pts[:, 1] - D @ sol
        keep = np.abs(resid) < 1.2
        if keep.all():
            break
        pts = pts[keep]
    s1 = sol[18] if slope_model == 'trend' else 0.0

    def line_y(k, x):
        return sol[k] + sol[17] * x + s1 * x * (noms[k] - ycen) / 1000

    zero = pts[pts[:, 2] == 16]
    zfit = np.polyfit(zero[:, 0], zero[:, 1], 1)
    straight = float((zero[:, 1] - np.polyval(zfit, zero[:, 0])).std())
    return line_y, float(resid.std()), straight, (sol[17] * 1000, s1)


def to_value(line_y, x, y):
    ys = np.array([line_y(k, x) for k in range(17)])
    order = np.argsort(ys)
    return float(np.interp(y, ys[order], np.array(VALS17)[order]))


def trace(a, vx, x0, x1, yseed, ylo, yhi, gridrows, tol=7, maxgap=45, avoid=None):
    """Follow a BROKEN stroke (dashed, dash-dot), bridging its gaps by linear prediction; runs lying on
    the already-traced solid curve (`avoid`) are not taken, so the trace cannot slide onto it."""
    avoid_y = {int(x): y for x, y in avoid} if avoid is not None and len(avoid) else {}
    pts, gap, pred = [], 0, yseed
    for x in range(int(x0), int(x1) + 1):
        if np.min(np.abs(vx - x)) <= 3:
            continue
        allrs = runs_in(a[:, x], ylo, yhi)
        gy = gridrows(x)
        ongrid = lambda r: r[1] - r[0] <= 3 and np.min(np.abs(gy - (r[0] + r[1]) / 2)) < 2.5
        rs = [r for r in allrs if not ongrid(r) and not (x in avoid_y and abs((r[0] + r[1]) / 2 - avoid_y[x]) < 3)]
        if len(pts) >= 4:
            last = np.array(pts[-8:])
            pred = np.polyval(np.polyfit(last[:, 0], last[:, 1], 1), x)
        elif pts:
            pred = pts[-1][1]
        best = None
        for r in rs:
            c = (r[0] + r[1]) / 2
            d = 0 if r[0] - tol / 2 <= pred <= r[1] + tol / 2 else min(abs(pred - r[0]), abs(pred - r[1]))
            if d <= tol + 0.35 * gap and (best is None or abs(c - pred) < abs(best - pred)):
                best = c
        if best is None:
            for r in allrs:
                if ongrid(r) and abs((r[0] + r[1]) / 2 - pred) <= 3:
                    best = (r[0] + r[1]) / 2
        if best is None:
            gap += 1
            if gap > maxgap:
                break
            continue
        gap = 0
        pts.append((x, best))
    return np.array(pts)


def trace_continuous(a, vx, x0, x1, yseed, ylo, yhi, tol=7, skip=2, max_steps=200000):
    """Follow an UNBROKEN stroke (the solid delta_F = 0 curve). From one column to the next the run must
    touch the previous one (within 2 px), except across a masked gridline column, where the run nearest
    the linear prediction is taken; up to `skip` columns of scan dropout are bridged the same way.
    Where more than one run touches (two strokes merged at a crossing) the one nearest the prediction
    is tried first; if that path then finds nothing for more than `skip` columns away from any
    gridline, it was the broken (dashed) stroke, and the trace backs up to the last branch and takes
    the other run."""
    cols = list(range(int(x0), int(x1) + 1))
    runs = {x: runs_in(a[:, x], ylo, yhi) for x in cols}
    masked = {x: np.min(np.abs(vx - x)) <= 3 for x in cols}
    path, stack, steps, i = [], [], 0, 0  # path: (x, centre, run); stack: untried runs per path entry
    while i < len(cols) and steps < max_steps:
        steps += 1
        x = cols[i]
        if masked[x]:
            i += 1
            continue
        pts = [(px, c) for px, c, _ in path[-8:]]
        if len(pts) >= 4:
            pts = np.array(pts)
            pred = np.polyval(np.polyfit(pts[:, 0], pts[:, 1], 1), x)
        else:
            pred = path[-1][1] if path else yseed
        prev = path[-1] if path else None
        near = lambda r, t: (0 if r[0] - t / 2 <= pred <= r[1] + t / 2
                             else min(abs(pred - r[0]), abs(pred - r[1]))) <= t
        if prev is not None and all(not masked[xx] for xx in range(prev[0] + 1, x)) and x - prev[0] == 1:
            cand = [r for r in runs[x] if r[0] <= prev[2][1] + 2 and r[1] >= prev[2][0] - 2]
        elif prev is not None and all(not masked[xx] for xx in range(prev[0] + 1, x)):
            cand = [r for r in runs[x] if near(r, 3)] if x - prev[0] <= skip + 1 else []
        else:
            cand = [r for r in runs[x] if near(r, tol)]
        cand.sort(key=lambda r: abs((r[0] + r[1]) / 2 - pred))
        if cand:
            path.append((x, (cand[0][0] + cand[0][1]) / 2, cand[0]))
            stack.append(cand[1:])
            i += 1
            continue
        if prev is not None and x - prev[0] <= skip:
            i += 1  # bridge a column of dropout
            continue
        while path and not stack[-1]:  # dead end: back up to the latest untried run
            path.pop()
            stack.pop()
        if not path:
            break
        alt = stack[-1].pop(0)
        xb = path[-1][0]
        path[-1] = (xb, (alt[0] + alt[1]) / 2, alt)
        i = cols.index(xb) + 1
    return np.array([(px, c) for px, c, _ in path])


def read_summary(a, cfg, label):
    vx = vertical_gridlines(a, cfg['y0'], cfg['y1'], cfg['vx0'], cfg['vx1'])
    xm = np.polyfit(MACHS17, vx, 1)
    mach_rms = float(((vx - np.polyval(xm, MACHS17)) / xm[0]).std())
    x_full = (vx[0] - 30, vx[-1] + 10)
    grid, rms, straight, slopes = horizontal_grid(a, vx, cfg['ytop'], cfg['yzero'], cfg['spans'], cfg['win'],
                                                  x_full, 'trend')
    grid_c, _, _, _ = horizontal_grid(a, vx, cfg['ytop'], cfg['yzero'], cfg['spans'], cfg['win'], x_full, 'common')
    px_per_unit = abs(grid(0, vx[8]) - grid(16, vx[8])) / 0.8
    print(f'{label}: Mach axis rms {mach_rms:.5f}; gridline fit rms {rms:.2f} px, zero axis straightness '
          f'{straight:.2f} px, slope {slopes[0]:.2f} px/1000 px + {slopes[1] * 1000:.2f} per 1000 px of height; '
          f'{px_per_unit:.0f} px per unit C_A')
    def gridrows(x):  # the gridlines actually drawn at column x
        drawn = any(xa <= x < xb for xa, xb in cfg['spans'])
        return np.array([grid(k, x) for k in range(16)] if drawn else [-1e9])
    spacing = (vx[-1] - vx[0]) / 16
    half = 0.22 * spacing
    x_start, x_end = np.polyval(xm, 0.6) + 4, np.polyval(xm, 1.2) - 2
    out = {}
    for name, seed in cfg['seeds'].items():
        ys = np.array([grid(k, x_start) for k in range(17)])
        y0 = float(np.interp(seed, VALS17[::-1], ys[::-1]))
        if name == 'solid':
            t = solid = trace_continuous(a, vx, x_start, x_end, y0, int(min(ys)) - 20, int(max(ys)) - 2,
                                         skip=cfg['skip'])
        else:
            t = trace(a, vx, x_start, x_end, y0, int(min(ys)) - 20, int(max(ys)) - 2, gridrows, avoid=solid)
        if DUMP:
            np.save(f'{DUMP}/{label.split()[0]}_{"forum" if cfg["page"] is None else "report"}_{name}.npy', t)
        out[name] = {}
        for m in TARGETS:
            xg = float(np.polyval(xm, m))
            sel = t[np.abs(t[:, 0] - xg) <= half] if len(t) else np.zeros((0, 2))
            if len(sel) < 4:
                continue
            c = np.polyfit(sel[:, 0], sel[:, 1], 2 if len(sel) > 8 else 1)
            yv = float(np.polyval(c, xg))
            v = to_value(grid, xg, yv)
            sides = []
            for side in (sel[sel[:, 0] < xg], sel[sel[:, 0] > xg]):
                if len(side) >= 4:
                    sides.append(to_value(grid, xg, np.polyval(np.polyfit(side[:, 0], side[:, 1], 1), xg)))
            lr = abs(sides[0] - sides[1]) / 2 if len(sides) == 2 else 0.0
            skew = abs(to_value(grid_c, xg, yv) - v)
            slope = abs(np.polyval(np.polyder(c), xg)) * xm[0] / px_per_unit  # dC_A/dM
            u = float(np.sqrt((rms / px_per_unit) ** 2 + (straight / px_per_unit) ** 2 + skew ** 2 + lr ** 2
                              + (mach_rms * slope) ** 2))
            out[name][m] = (v, u)
    return out


def snap_line(a, x0, xa, xb, y_guess, win=9, minpts=40):
    pts = []
    for x in range(max(xa, 0), min(xb, a.shape[1])):
        idx = np.nonzero(a[y_guess - win:y_guess + win + 1, x])[0]
        if 1 <= len(idx) <= 5 and idx.max() - idx.min() <= 4:
            pts.append((x, y_guess - win + idx.mean()))
    pts = np.array(pts)
    if len(pts) < minpts:
        return None
    for _ in range(6):
        c = np.polyfit(pts[:, 0] - x0, pts[:, 1], 1)
        r = pts[:, 1] - np.polyval(c, pts[:, 0] - x0)
        keep = np.abs(r) < 1.2
        if keep.all():
            break
        pts = pts[keep]
    return None if len(pts) < minpts else c[1]


def symbol_cluster(a, x0, y_lo, y_hi, gridys, half=16, pad=40):
    cols = list(range(x0 - half, x0 + half + 1))
    ya, yb = int(y_lo) - pad, int(y_hi) + pad
    cnt = np.array([a[y, cols].sum() for y in range(ya, yb + 1)])
    base = np.median(cnt)  # the alpha = 0 line's own ink
    rows = []
    for i, y in enumerate(range(ya, yb + 1)):
        if y < y_lo or y > y_hi:
            continue
        if gridys and min(abs(y - g) for g in gridys) <= 2 and cnt[i] > 0.8 * len(cols):
            continue
        if cnt[i] >= base + 2:
            rows.append(y)
    if not rows:
        return None
    rows = np.array(rows)
    blocks = [b for b in np.split(rows, np.nonzero(np.diff(rows) > 6)[0] + 1) if len(b) >= 8]
    if not blocks:
        return None
    mid = (y_lo + y_hi) / 2
    b = min(blocks, key=lambda b: abs((b.min() + b.max()) / 2 - mid))
    return b.min(), b.max()


def read_alpha0(doc, panels, cache):
    out = {}
    for model, rows in panels.items():
        for pno, x0, yz, ppu, step, k_hi, k_lo, wins in rows:
            if pno not in cache:
                cache[pno] = page_bitmap(doc, pno)
            a = cache[pno]
            ys, vs = [], []
            for k in range(-k_lo, k_hi + 1):
                y = snap_line(a, x0, x0 - 200, x0 + 1000, int(round(yz - k * step * ppu)))
                if y is not None:
                    ys.append(y)
                    vs.append(k * step)
            ys, vs = np.array(ys), np.array(vs)
            for _ in range(4):
                c = np.polyfit(vs, ys, 1)
                keep = np.abs(ys - np.polyval(c, vs)) < 2.0
                if keep.all():
                    break
                ys, vs = ys[keep], vs[keep]
            gridys = list(np.polyval(c, vs))
            for m, windows in wins.items():
                r = {}
                for which, (w0, w1) in zip(('on', 'off'), windows):
                    lo, hi = sorted((np.polyval(c, w0), np.polyval(c, w1)))
                    cl = symbol_cluster(a, x0, lo, hi, gridys)
                    if cl is None:
                        continue
                    v = ((cl[0] + cl[1]) / 2 - c[1]) / c[0]
                    u = max(cl[1] - cl[0] + 1 - SYMBOL_PX, 4) / 2 / abs(c[0])
                    r[which] = (v, u)
                out[(model, m)] = r
    return out


def main():
    doc = pymupdf.open(sys.argv[1])
    reads = {}
    print('METHOD 1 - Figs 11/12 C_A,corr panel, NTRS report scan')
    for model, cfg in SUMMARY['report'].items():
        reads[('report', model)] = read_summary(page_bitmap(doc, cfg['page'], cfg['thresh']), cfg,
                                                f'  {model} (PDF p.{cfg["page"]})')
    if len(sys.argv) >= 4:
        print('METHOD 1 again - the TRF reproductions of the same figures (a different scan)')
        for model, path in zip(('Short', 'Long'), sys.argv[2:4]):
            cfg = SUMMARY['forum'][model]
            reads[('forum', model)] = read_summary(png_bitmap(path, cfg['thresh']), cfg, f'  {model} (TRF image)')
    for model in ('Short', 'Long'):
        print(f'\n{model}: C_A,corr, value +/- read uncertainty')
        hdr = '   M    solid dF=0        dashed dF=2       fins-off          fins-off anchor'
        if ('forum', model) in reads:
            hdr += '   solid, TRF image'
        print(hdr)
        rep = reads[('report', model)]
        for m in TARGETS:
            cells = []
            for name in ('solid', 'dashed', 'finsoff'):
                v = rep[name].get(m)
                cells.append(f'{v[0]:.4f} +/-{v[1]:.4f}' if v else '       -         ')
            anc = FINSOFF_ANCHOR[model].get(m)
            line = f'  {m:.2f}  ' + '  '.join(cells) + (f'   {anc:.4f}' if anc else '         ')
            if ('forum', model) in reads:
                v = reads[('forum', model)]['solid'].get(m)
                line += f'         {v[0]:.4f} +/-{v[1]:.4f}' if v else ''
            print(line)
    print('\nMETHOD 2 - C_A (Fig 7(a)/9(a)) + C_p,b (Fig 3/5) x A_b/S, at alpha = 0, the tested Mach numbers')
    cache = {}
    ca = read_alpha0(doc, CA_PANELS, cache)
    cpb = read_alpha0(doc, CPB_PANELS, cache)
    print('  model   M     C_A on   C_p,b on  -> C_A,corr fins-on      | fins-off check: C_A,corr  anchor')
    m2 = {}
    for key in ca:
        model, m = key
        on = None
        if 'on' in ca[key] and 'on' in cpb.get(key, {}):
            v = ca[key]['on'][0] + A_B_OVER_S * cpb[key]['on'][0]
            u = float(np.sqrt(ca[key]['on'][1] ** 2 + (A_B_OVER_S * cpb[key]['on'][1]) ** 2 + C_AB_CONVERSION ** 2))
            m2[key] = (v, u)
            on = f'{ca[key]["on"][0]:.4f}  {cpb[key]["on"][0]:+.4f}  -> {v:.4f} +/-{u:.4f}'
        off = '   -  '
        if 'off' in ca[key] and 'off' in cpb.get(key, {}):
            off = f'{ca[key]["off"][0] + A_B_OVER_S * cpb[key]["off"][0]:.4f}'
        print(f'  {model:6s} {m:.2f}  {on}   | {off}   {FINSOFF_ANCHOR[model][m]:.4f}')

    print("\nDECISION - delta_F = 0 against the value gated until 2026-10-11. u = the read's own uncertainty, never")
    print(f'below the {DIGITIZATION_FLOOR} digitization term. A second method AGREES when it lies within the RSS of the')
    print('two uncertainties. REPLACE = the read differs from the gated value by more than u and a second method agrees.')
    print('  model   M     gated   read     u       read-gated | TRF image (agrees) | Figs 7/9 + 3/5 (agrees) | verdict')
    for model in ('Short', 'Long'):
        for m, gated in GATED_BEFORE[model].items():
            r, ur = reads[('report', model)]['solid'][m]
            ur = max(ur, DIGITIZATION_FLOOR)
            agree = []
            f = reads.get(('forum', model), {}).get('solid', {}).get(m)
            fs = '        -         '
            if f:
                ok = abs(r - f[0]) <= np.hypot(ur, max(f[1], DIGITIZATION_FLOOR))
                agree.append(ok)
                fs = f'{f[0]:.4f} ({"yes" if ok else "NO "})    '
            m2s = '        -              '
            if (model, m) in m2:
                v, u = m2[(model, m)]
                ok = abs(r - v) <= np.hypot(ur, u)
                agree.append(ok)
                m2s = f'{v:.4f} +/-{u:.4f} ({"yes" if ok else "NO "})'
            differs = abs(r - gated) > ur
            verdict = 'REPLACE' if differs and any(agree) else ('keep' if not differs else 'differs, unconfirmed')
            print(f'  {model:6s} {m:.2f}  {gated:.3f}  {r:.4f}  {ur:.4f}  {r - gated:+.4f}    | {fs} | {m2s} | {verdict}')


if __name__ == '__main__':
    main()
