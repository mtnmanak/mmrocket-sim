"""Read the fins-on (delta_F = 0) x_cp curve of NASA TN D-4013 Figures 11 and 12.

Source: Ferris, NASA TN D-4013 (1967), NTRS
https://ntrs.nasa.gov/api/citations/19670020050/downloads/19670020050.pdf
(64-page scan, no text layer; Figure 11 = PDF page 62, Figure 12 = PDF page 63).
Not committed - fetch it and pass its path:

    python validation/digitize/read-d4013-xcp.py <path to 19670020050.pdf>

Prints the reads the `cp-subsonic-tunnel-scanread` series in anchors.json carry.

Method (2026-10-11):
- Mach axis: the 17 printed vertical gridlines (M0.50..1.30, 0.05 apart), positions
  measured on each page image; the curves start at M0.60, the first Mach tested, which
  checks the axis independently.
- x_cp axis: the panel's own printed horizontal gridlines (70/75/80/85/90 %L), fitted
  jointly with one common slope and a per-line offset over the span where each figure
  actually draws them (Fig 11: M0.50-0.70; Fig 12: M1.00-1.30). Local gridlines, not a
  whole-page de-skew: the two figures shear differently from panel to panel on the scan.
- The curve: in each column within +/-6 px of the target Mach (gridline columns
  excluded), the dark runs of 2-9 px; runs of <= 3 px sitting on a horizontal gridline are
  dropped; the LOWEST remaining run is the solid delta_F = 0 curve (the dashed
  delta_F = 2 curve lies above it over M0.60-0.90 in both figures, and is interrupted).
  Read = mean of the run centres. At M0.60 the two curves start together and the run is
  their merged stroke.
"""
import sys

import numpy as np
import pymupdf
from PIL import Image

MACHS = [0.5 + 0.05 * i for i in range(17)]
FIGS = {
    # name: (pdf page, vertical gridline x px, horizontal gridline (y px, %L), gridline span, curve window)
    'Fig 11 (Short)': (62, [612.5, 686, 760, 833, 907, 980.5, 1054, 1128, 1201, 1275, 1349, 1422.5,
                            1496, 1569, 1643, 1716.5, 1790],
                       [(497, 90), (569, 85), (641, 80), (713, 75), (786, 70)], (610, 905), (690, 800)),
    'Fig 12 (Long)': (63, [587, 657.5, 728, 798, 869, 939, 1009, 1079, 1149, 1219, 1289.5, 1360, 1430,
                           1500, 1570.5, 1641, 1711],
                      [(508, 90), (575, 85), (643, 80), (710, 75), (778, 70)], (1300, 1710), (640, 760)),
}
TARGETS = [0.6, 0.7, 0.8, 0.85, 0.9]


def page_bitmap(doc, pno):
    page = doc[pno - 1]
    pix = pymupdf.Pixmap(doc, page.get_images(full=True)[0][0])
    img = Image.frombytes('L' if pix.n == 1 else 'RGB', (pix.width, pix.height), pix.samples)
    return np.array(img.convert('L')) < 128


def read_figure(a, vx, hlines, hx, ywin):
    vx = np.array(vx, dtype=float)
    x_of_m = np.polyfit(MACHS, vx, 1)
    pts = []
    for yn, val in hlines:
        for x in range(*hx):
            if np.min(np.abs(vx - x)) <= 4:
                continue
            idx = np.nonzero(a[yn - 7:yn + 8, x])[0]
            if 1 <= len(idx) <= 5 and idx.max() - idx.min() <= 4:
                pts.append((x, yn - 7 + idx.mean(), val))
    pts = np.array(pts)
    vals = sorted(set(pts[:, 2]))
    for _ in range(5):
        design = np.zeros((len(pts), 1 + len(vals)))
        design[:, 0] = pts[:, 0]
        for i, v in enumerate(vals):
            design[pts[:, 2] == v, 1 + i] = 1
        sol, *_ = np.linalg.lstsq(design, pts[:, 1], rcond=None)
        resid = pts[:, 1] - design @ sol
        keep = np.abs(resid) < 1.2
        if keep.all():
            break
        pts = pts[keep]
    slope, offsets = sol[0], sol[1:]

    def value(x, y):
        fit = np.polyfit(slope * x + offsets, np.array(vals), 1)
        return float(np.polyval(fit, y))

    print(f'  gridline fit: slope {slope * 1000:.2f} px/1000 px, rms {resid.std():.3f} px, {len(pts)} px')
    lo, hi = ywin
    for mach in TARGETS:
        xc = int(round(float(np.polyval(x_of_m, mach))))
        reads = []
        for x in range(xc - 6, xc + 7):
            if np.min(np.abs(vx - x)) <= 4:
                continue
            idx = np.nonzero(a[lo:hi, x])[0] + lo
            runs = []
            for y in idx:
                if runs and y - runs[-1][-1] <= 1:
                    runs[-1].append(y)
                else:
                    runs.append([y])
            grid = slope * x + offsets
            runs = [r for r in runs if 2 <= len(r) <= 9
                    and not (len(r) <= 3 and np.min(np.abs(grid - np.mean(r))) < 2.5)]
            if runs:
                reads.append(value(x, np.mean(max(runs, key=lambda r: r[-1]))))
        reads = np.array(reads)
        print(f'  M{mach:.2f}: x_cp {reads.mean():.2f} %L  ({len(reads)} columns, spread {np.ptp(reads):.2f})')


def main():
    doc = pymupdf.open(sys.argv[1])
    for name, (pno, vx, hlines, hx, ywin) in FIGS.items():
        print(name)
        read_figure(page_bitmap(doc, pno), vx, hlines, hx, ywin)


if __name__ == '__main__':
    main()
