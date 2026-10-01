"""
The Tripoli Motor Testing (TMT) certification letters for AeroTech's motors,
read into aerotech-certified.json: the reference aerotech-certified.test.mjs
holds the shipped motor catalogue to (board Tier 1 row 8 (c), 2026-10-01).

WHY. v0.116's impulse-agreement gate compares a picked curve's integral with
the catalogue's certified total, and both come from thrustcurve.org. When the
two agree with each other the gate passes, whatever the certification says:
the F52C and the H13ST ship 13.7 % under their certification letters on
total impulse, peak AND average thrust, with both bundled curves agreeing with
the low figure (docs/research/aerotech-document-set-2026-09-08.md section 1).
These letters are a reference from outside thrustcurve.org, and a reference
can be wrong too: for those two, AeroTech's own pages side with thrustcurve.org
on total impulse (aerotech-certified.test.mjs, KNOWN).

WHAT IS READ. `Cert Docs/TRA` under `docs/RCS Schematics` (local-only,
gitignored): the TRA certification documents AeroTech's maker, RCS Rocket Motor
Components, links from its own page (PUBLISHED_ON), fetched by the folder's
Download-CertDocs.ps1, whose list gives each file's URL. Of its 216 PDFs this
reads the 43 letters in the form TMT has used since 2019 (dated 2019 to 2025),
one labelled row per figure with SI beside imperial ("Manufacturer's Designation
... TMT Nomenclature ... Total Impulse ... Max Impulse ... Average Impulse ...
Number of Motors Tested"). It is the only form with a "Manufacturer's
Designation" row; the earlier letters, tables and charts have none (the 134
with a text layer are dated December 1998 to August 2018, and the 39 scans'
files were made in 1998 to 2002), and are a different job (the research note's
section 1(b)).

  - 30 have a text layer, read by WORD COORDINATES (`lines`, `text_rows`).
  - 13 are scans with no text layer, and this machine has no OCR. They were
    read by eye from the page rendered at 170 dpi, and their cells are typed
    into TRANSCRIBED exactly as printed, typos included; the run refuses one
    that has since gained a text layer, so a transcription never stands in for
    text that could be read. Every page of all 52 scans in the folder was
    looked at to find them; the other 39 are the older forms.

Both kinds of row go through the same `interpret`, so a figure means the same
thing whichever way it was read, and every row keeps the cell it came from in
`printed`.

NEVER FROM FLATTENED TEXT (CLAUDE.md). `page.get_text()` returns a letter's
labels and values as separate lines, and where a cell is empty the next
column's value takes its place. Here every word keeps its position: words on
one visual line (centres within 3 pt) form a row, a gap wider than 12 pt
between two words starts a new cell, the first cell is the label, and a value
cell is told SI from imperial by its UNIT, never by its place in the row. A
cell that is neither, or a row that carries two SI cells, stops the run.

TMT LABELS THRUST "IMPULSE". "Max Impulse" and "Average Impulse" are in N and
lbf: the peak and average thrust. They are written here as maxThrustN and
avgThrustN, the catalogue's own names, so the screen compares like with like.

A LETTER THAT AVERAGES TWO MOTORS. The N2700W-PS letter prints each motor's
figure and then their average in brackets, "10,637, 9969.7 N.s [10,322 N.s]";
the bracket is the certified figure (its TMT nomenclature, "10,322 N2717", is
built from it), and the individual figures are kept in `each`. A letter that
prints two figures and no bracket ("Burn time 2.7, 2.662 sec") certifies none:
the field is null and the figures are in `each`.

Usage:
  python extract-aerotech-certified.py [--source "<RCS Schematics folder>"] [--out <file>] [--check]

--source defaults to $RCS_SCHEMATICS, then to the repo's docs/RCS Schematics.
--out defaults to aerotech-certified.json beside this file. --check compares
instead of writing, and exits 1 when the committed file is not what the
letters give.
"""
import argparse
import json
import os
import re
import sys
from urllib.parse import quote

# `import pymupdf`, not `import fitz` (extract-nozzle-pdfs.py: the old name's
# deprecation warning goes to stdout).
import pymupdf

pymupdf.set_messages(stream=sys.stderr)

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SOURCE = os.path.join(HERE, '..', '..', '..', 'docs', 'RCS Schematics')
DEFAULT_OUT = os.path.join(HERE, 'aerotech-certified.json')

# The manufacturer's own page linking every letter read here (read 2026-10-01).
PUBLISHED_ON = 'https://www.rocketmotorparts.com/page/nar-tra-certification-docs'

# The letters scanned to images: every cell, as printed, read from the page
# rendered at 170 dpi. Signed by Alan C. Whitmore, TMT Chair, every one.
WHITMORE = 'Alan C. Whitmore'
TRANSCRIBED = {
    '24mm Quest Single Use/Quest Q-Jet E35-5, 8, 11W.pdf': {
        # "June 3, 2002" as printed: the body says tested April 29, 2022.
        'letterDate': 'June 3, 2002', 'testedOn': 'April 29, 2022', 'signedBy': WHITMORE,
        'rows': {
            "Manufacturer's Designation": ['{E35-5,8,11W }', '[single use]'],
            'Propellant': ['White Lightning'],
            'TMT Nomenclature': ['39 E34'],
            'Diameter': ['0.934″', '23.73 mm'],
            'Overall Length': ['4.440″', '112.77 mm'],
            'Loaded Mass': ['0.121 lb', '55.09 g'],
            'Propellant Mass': ['0.056 lb*', '25.4 g*'],
            'Burnout Mass': ['0.054 lb', '24.54 g'],
            'Burn time': ['1.079 ± 0.056 sec'],
            'Total Impulse': ['8.853 ± 0.126 lbf.s', '39.38 ± 0.56 N.s'],
            'Max Impulse': ['9.882 ± 0.997 lbf', '43.96 ± 4.43 N'],
            'Average Impulse': ['7.789 ± 0.284 lbf', '33.81 ± 3.11 N'],
            'Number of Motors Tested': ['12'],
        },
    },
    '24mm Quest Single Use/Quest Q-Jet F41-5, 8, 11W.pdf': {
        'letterDate': 'September 21, 2023', 'testedOn': 'September 20, 2023', 'signedBy': WHITMORE,
        'rows': {
            "Manufacturer's Designation": ['{F41-5,8,11W }', '[single use]'],
            'Propellant': ['White Lightning'],
            'TMT Nomenclature': ['48 F42'],
            'Diameter': ['0.937″', '23.81 mm'],
            'Overall Length': ['4.449″', '112.99 mm'],
            'Loaded Mass': ['0.1253 lb', '56.855 g'],
            'Propellant Mass': ['0.060 lb*', '27.1 g*'],
            'Burnout Mass': ['0.0541 lb', '24.534 g'],
            'Burn time': ['1.115 ± 0.054 sec'],
            'Total Impulse': ['10.713 ± 0.380 lbf.s', '47.651 ± 1.690 N.s'],
            'Max Impulse': ['12.176 ± 0.897 lbf', '54.161 ± 3.990 N'],
            'Average Impulse': ['9.484 ± 0.673 lbf', '42.185 ± 2.995 N'],
            'Number of Motors Tested': ['10'],
        },
    },
    '38mm High Power Single-Use/I40N-P DMS.pdf': {
        'letterDate': 'October 18, 2021', 'testedOn': 'October 16, 2021', 'signedBy': WHITMORE,
        'rows': {
            "Manufacturer's Designation": ['I40N-P', 'DMS [end burner]'],
            'Propellant': ['Warp Nine'],
            'TMT Nomenclature': ['375 I38'],
            'Diameter': ['1.51″', '38.25 mm'],
            'Overall Length': ['7.99″', '202.97 mm'],
            'Loaded Mass': ['0.793 lb', '359.87 g'],
            'Propellant Mass': ['0.434 lb*', '197 g*'],
            'Burnout Mass': ['0.330 lb', '149.82 g'],
            'Burn time': ['9.951 ± 0.404 sec'],
            'Total Impulse': ['84.28 ± 2.43 lbf.s', '374.90 ± 10.82 N.s'],
            'Max Impulse': ['22.85 ± 0.53 lbf', '101.66 ± 2.34 N'],
            # "2.422.06" as printed: no number, so no plus-minus.
            'Average Impulse': ['8.48 ± 0.54 lbf', '37.73 ± 2.422.06 N'],
            'Number of Motors Tested': ['3'],
        },
    },
    '54mm High Power Single-Use/J1265ST-14A DMS.pdf': {
        'letterDate': 'December 6, 2022', 'testedOn': 'December 4, 2022', 'signedBy': WHITMORE,
        'rows': {
            "Manufacturer's Designation": ['J1265ST-14A', '[single use, DMS]'],
            'Propellant': ['Super Thunder'],
            'TMT Nomenclature': ['1072 J1261'],
            'Diameter': ['2.125″', '53.98 mm'],
            'Overall Length': ['15.641″', '397.27 mm'],
            'Loaded Mass': ['2.414 lb', '1095.1 g'],
            'Propellant Mass': ['1.1177 lb*', '507 g*'],
            'Burnout Mass': ['1.212 lb', '549.71 g'],
            'Burn time': ['0.85 ± 0.007 sec'],
            # 251.07 lbf.s as printed; the 1072.3 N.s beside it is 241.07 lbf.s.
            'Total Impulse': ['251.07 ± 17.04 lbf.s', '1072.3 ± 1.563 N.s'],
            'Max Impulse': ['392.36 ± 57.25 lbf', '1745.3 ± 254.7 N'],
            'Average Impulse': ['283.51 ± 1.542 lbf', '1261.1 ± 6.9 N'],
            'Number of Motors Tested': ['3'],
        },
    },
    '54mm High Power Single-Use/K62N-P DMS.pdf': {
        'letterDate': 'December 6, 2022', 'testedOn': 'December 4, 2022', 'signedBy': WHITMORE,
        'rows': {
            "Manufacturer's Designation": ['K62N-P', '[single use, DMS]'],
            'Propellant': ['Warp Nine'],
            'TMT Nomenclature': ['1438 K63'],
            'Diameter': ['2.125″', '53.98 mm'],
            'Overall Length': ['14.734″', '374.25 mm'],
            'Loaded Mass': ['2.815 lb', '1276.9 g'],
            'Propellant Mass': ['1.832 lb*', '831 g*'],
            'Burnout Mass': ['0.820 lb', '372.1 g'],
            'Burn time': ['23.1 ± 1.40 sec'],
            'Total Impulse': ['323.4 ± 3.85 lbf.s', '1438.5 ± 17.08 N.s'],
            'Max Impulse': ['58.2 ± 3.09 lbf', '258.7 ± 13.75 N'],
            'Average Impulse': ['14.10 ± 1.04 lbf', '62.54 ± 4.64 N'],
            'Number of Motors Tested': ['3'],
        },
    },
    '98mm High Power Single Use/N1975W-PS DMS.pdf': {
        'letterDate': 'October 18, 2021', 'testedOn': 'October 16, 2021', 'signedBy': WHITMORE,
        'rows': {
            "Manufacturer's Designation": ['N1975W-PS', '[DMS, single use]'],
            'Propellant': ['White Lightning'],
            'TMT Nomenclature': ['13,893 N1971'],
            'Diameter': ['3.874″', '98.39 mm'],
            'Overall Length': ['43.706″', '1110.13 mm'],
            'Loaded Mass': ['26.915 lb', '12,208.43 g'],
            'Propellant Mass': ['16.923 lb*', '7676 g*'],
            'Burnout Mass': ['9.040 lb', '4100.47 g'],
            'Burn time': ['7.048 ± 0.127 sec'],
            'Total Impulse': ['3123.29 ± 45.46 lbf.s', '13,893.1 ± 202.23 N.s'],
            'Max Impulse': ['652.67 ± 70.75 lbf', '2903.25 ± 314.73 N'],
            'Average Impulse': ['443.4 ± 1.55 lbf', '1970.7 ± 6.93 N'],
            'Number of Motors Tested': ['2'],
        },
    },
    '98mm High Power Single Use/O5500X-PS DMS.pdf': {
        'letterDate': 'January 10, 2023', 'testedOn': 'January 7, 2023', 'signedBy': WHITMORE,
        'rows': {
            "Manufacturer's Designation": ['O5500X-PS', '[single use - DMS]'],
            'Propellant': ['Propellant X'],
            'TMT Nomenclature': ['21,384 O5515'],
            'Diameter': ['3.867″', '98.45 mm'],
            'Overall Length': ['59.344″', '1507.3 mm'],
            'Loaded Mass': ['37.00 lb', '16,783 g'],
            'Propellant Mass': ['21.559 lb*', '9779 g*'],
            'Burnout Mass': ['14.925 lb', '6769.9 g'],
            'Burn time': ['4.026 sec'],
            'Total Impulse': ['4807 lbf.s', '21,384 N.s'],
            'Max Impulse': ['1697.7 lbf', '7551.5 N'],
            'Average Impulse': ['1239.7 lbf', '5514.6 N'],
            'Number of Motors Tested': ['2'],
        },
    },
    'RMS-54-852/J615ST-20A Aerospike.pdf': {
        'letterDate': 'October 18, 2021', 'testedOn': 'October 16, 2021', 'signedBy': WHITMORE,
        'rows': {
            "Manufacturer's Designation": ['J615ST-20A', 'RMS [uses the 54/852 hardware]'],
            'Propellant': ['Super Thunder'],
            'TMT Nomenclature': ['745 J615'],
            'Diameter': ['2.125″', '53.98 mm'],
            'Overall Length': ['9.466″', '240.43 mm'],
            'Loaded Mass': ['1.768 lb', '801.74 g'],
            'Propellant Mass': ['0.817 lb*', '370.5 g*'],
            'Burnout Mass': ['0.896 lb', '406.55 g'],
            'Burn time': ['1.199 ± 0.046 sec'],
            'Total Impulse': ['167.58 ± 3.19 lbf.s', '745.45 ± 14.20 N.s'],
            'Max Impulse': ['209.66 ± 27.77 lbf', '933.94 ± 123.52 N'],
            'Average Impulse': ['138.27 ± 5.41 lbf', '615.06 ± 24.08 N'],
            'Number of Motors Tested': ['6'],
        },
    },
    'RMS-75-10240/N2700W-PS.pdf': {
        # Filed and published as the N2700W-PS. The letter types "M2700W" and
        # "M2700W-PS"; its own TMT nomenclature, "10,322 N2717", is an N.
        'letterDate': 'April 17, 2024', 'testedOn': 'March 30, 2024', 'signedBy': WHITMORE,
        'rows': {
            "Manufacturer's Designation": ['M2700W-PS', '[for the 75/10240 hardware]'],
            'Propellant': ['White Lightning'],
            'TMT Nomenclature': ['10,322 N2717'],
            'Diameter': ['2.968″', '75.39 mm'],
            'Overall Length': ['48.522″', '1232.5 mm'],
            'Loaded Mass': ['19.97 lb', '9058.2 g'],
            'Propellant Mass': ['11.629 lb*', '5275 g*'],
            'Burnout Mass': ['7.58 lb', '3438.2 g'],
            'Burn time': ['3.962, 3.635 sec [avg = 3.799 sec]'],
            # Each motor's figure, then the average in brackets on the line below.
            'Total Impulse': ['2399.4, 2241.3 lbf.s [2320.4 lbf.s]', '10,637, 9969.7 N.s [10,322 N.s]'],
            'Max Impulse': ['1248.5, 830.82 lbf [1039.7 lbf]', '5553.5, 3695.7 N [4624.6 N]'],
            # "2741,2" as printed.
            'Average Impulse': ['605.31, 616.25 lbf [610.8 lbf]', '2692.6, 2741,2 N [2716.9 N]'],
            'Number of Motors Tested': ['2'],
        },
    },
    'RMS-75-1280/K750ST-P.pdf': {
        'letterDate': 'May 9, 2022', 'testedOn': 'May 7, 2022', 'signedBy': WHITMORE,
        'rows': {
            "Manufacturer's Designation": ['K750ST-P', '[75/1280 hardware]'],
            'Propellant': ['Super Thunder'],
            'TMT Nomenclature': ['1299 K747'],
            'Diameter': ['2.971″', '75.46 mm'],
            'Overall Length': ['10.5″', '266.7 mm'],
            'Loaded Mass': ['4.2934 lb', '1947.5 g'],
            'Propellant Mass': ['1.312 lb*', '595g*'],
            'Burnout Mass': ['1.7185 lb', '779.52 g'],
            'Burn time': ['1.740 ± .004 sec'],
            'Total Impulse': ['292.42 ± 0.83 lbf.s', '1298.73 ± 6.40 N.s'],
            'Max Impulse': ['187.87 ± 3.55 lbf', '835.69 ± 15.79 N'],
            'Average Impulse': ['167.83 ± 0.51 lbf', '746.56 ± 2.26 N'],
            'Number of Motors Tested': ['3'],
        },
    },
    'RMS-75-2560/K1800ST-PS.pdf': {
        'letterDate': 'August 13, 2022', 'testedOn': 'August 13, 2022', 'signedBy': WHITMORE,
        'rows': {
            "Manufacturer's Designation": ['K1800ST-P S', '[75/2560 hardware]'],
            'Propellant': ['Super Thunder'],
            'TMT Nomenclature': ['2443 K1776'],
            'Diameter': ['2.960″', '75.18 mm'],
            'Overall Length': ['15.828″', '402.0 mm'],
            'Loaded Mass': ['6.11 lb', '2771.5 g'],
            'Propellant Mass': ['2.454 lb*', '1113 g*'],
            'Burnout Mass': ['3.494 lb', '1584.6 g'],
            'Burn time': ['1.374 ± .011 sec'],
            'Total Impulse': ['549.36 ± 3.136 lbf.s', '2443.7 ± 13.96 N.s'],
            'Max Impulse': ['468.13 ± 1.868 lbf', '2082.4 ± 8.29 N'],
            'Average Impulse': ['399.37 ± 4.97 lbf', '1776.5 ± 22.13 N'],
            'Number of Motors Tested': ['3'],
        },
    },
    'RMS-75-5120/M2225WS-PS.pdf': {
        'letterDate': 'January 8, 2023', 'testedOn': 'January 7, 2023', 'signedBy': WHITMORE,
        'rows': {
            "Manufacturer's Designation": ['M2225WS-PS', '[For the 75/5120 case]'],
            'Propellant': ['Super White Lightning'],
            'TMT Nomenclature': ['5205 M2239'],
            'Diameter': ['2.958″', '75.13 mm'],
            'Overall Length': ['27.234″', '691.75 mm'],
            'Loaded Mass': ['10.35 lb', '4694.7 g'],
            'Propellant Mass': ['5.139 lb*', '2331 g*'],
            'Burnout Mass': ['4.950 lb', '2245.3 g'],
            'Burn time': ['2.323 sec'],
            'Total Impulse': ['1171.2 lbf.s', '5205 N.s'],
            'Max Impulse': ['543.68 lbf', '2418.4 N'],
            'Average Impulse': ['503.39 lbf', '2239.2 N'],
            'Number of Motors Tested': ['2'],
        },
    },
    'RMS-98-10240/M6000ST (2022 redesign).pdf': {
        'letterDate': 'May 9, 2022', 'testedOn': 'May 7, 2022', 'signedBy': WHITMORE,
        'rows': {
            "Manufacturer's Designation": ['M6000ST-P', '[98/10240 hardware]'],
            'Propellant': ['Super Thunder'],
            'TMT Nomenclature': ['8247 M5959'],
            'Diameter': ['3.870″', '98.3 mm'],
            'Overall Length': ['31.813″', '808.04 mm'],
            'Loaded Mass': ['17.7 lb', '8028.58 g'],
            'Propellant Mass': ['8.527 lb*', '3868 g*'],
            'Burnout Mass': ['9.02 lb', '4091.4 g'],
            'Burn time': ['1.382 sec'],
            'Total Impulse': ['1854 lbf.s', '8247.1 N.s'],
            'Max Impulse': ['1526.2 lbf', '6788.7 N'],
            'Average Impulse': ['1339.6 lbf', '5958.9 N'],
            'Number of Motors Tested': ['3'],
        },
    },
}

# ------------------------------------------------------------------ reading

LABELS = (
    "Manufacturer's Designation", 'Propellant', 'TMT Nomenclature', 'Diameter', 'Overall Length',
    'Loaded Mass', 'Propellant Mass', 'Burnout Mass', 'Burn time', 'Total Impulse', 'Max Impulse',
    'Average Impulse', 'Number of Motors Tested',
)
# Only the 2025 letters have this row; the earlier ones say it beside the designation.
HARDWARE = 'Motor Hardware'
# The 2019-2024 letters write "Burn time", the 2025 ones "Burn Time".
LABEL_KEY = {label.lower(): label for label in (*LABELS, HARDWARE)}

ROW_TOLERANCE_PT = 3.0
CELL_GAP_PT = 12.0


def tidy(text):
    """Typographic quotes and primes as plain ones, whitespace collapsed."""
    text = text.replace('’', "'").replace('”', '″').replace('"', '″')
    return re.sub(r'\s+', ' ', text).strip()


def lines(doc):
    """Every visual line of the document, page by page, as its cells in reading order.

    Words whose vertical centres lie within ROW_TOLERANCE_PT of the line's
    running centre are one line; inside it, a gap wider than CELL_GAP_PT between
    one word's right edge and the next word's left edge starts a new cell.
    """
    out = []
    for page in doc:
        words = sorted(page.get_text('words'), key=lambda w: ((w[1] + w[3]) / 2, w[0]))
        rows, cur, centre = [], [], None
        for w in words:
            c = (w[1] + w[3]) / 2
            if centre is None or abs(c - centre) <= ROW_TOLERANCE_PT:
                cur.append(w)
                centre = c if centre is None else (centre * (len(cur) - 1) + c) / len(cur)
            else:
                rows.append(cur)
                cur, centre = [w], c
        if cur:
            rows.append(cur)
        for row in rows:
            row.sort(key=lambda w: w[0])
            cells, cell, right = [], [], None
            for w in row:
                if right is not None and w[0] - right > CELL_GAP_PT:
                    cells.append(' '.join(cell))
                    cell = []
                cell.append(w[4])
                right = w[2]
            cells.append(' '.join(cell))
            out.append([tidy(c) for c in cells])
    return out


def text_rows(doc, where):
    """Label -> value cells, for a letter with a text layer; and its whole text, as lines.

    The 2019-2024 letters set the label in its own column ("Total Impulse | 17.25
    +- 0.14 lbf.s | 76.73 +- 0.60 N.s"); the 2025 ones write "Label: value
    (imperial)" on one line. Either way a label is matched whole, never as the
    start of a longer one ("Propellant" is not "Propellant Mass").
    """
    rows = {}
    plain = []
    for cells in lines(doc):
        plain.append(' '.join(cells))
        first = cells[0]
        colon = re.match(r"^([A-Za-z' ]+?):\s*(.*)$", ' '.join(cells))
        if colon and colon.group(1).lower() in LABEL_KEY:
            label = LABEL_KEY[colon.group(1).lower()]
            values = [colon.group(2)]
        elif first.lower() in LABEL_KEY and len(cells) > 1:
            label = LABEL_KEY[first.lower()]
            values = cells[1:]
        else:
            continue
        if label in rows:
            raise SystemExit(f'{where}: "{label}" appears twice')
        rows[label] = values
    return rows, plain


# ---------------------------------------------------------------- numbers

NUMBER = r'(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+,\d{1,2}(?!\d)|\d*\.\d+|\d+)'


def number(token):
    """A printed number: "13,893.1", ".69", and "2741,2" (a decimal comma: two digits, not three)."""
    token = token.strip()
    if re.fullmatch(r'\d{1,3}(?:,\d{3})+(?:\.\d+)?', token):
        return float(token.replace(',', ''))
    if re.fullmatch(r'\d+,\d{1,2}', token):
        return float(token.replace(',', '.'))
    if re.fullmatch(r'\d*\.\d+|\d+\.?', token):
        return float(token)
    return None


def as_number(v):
    """A float that is a whole number written as an int, so JSON keeps "30", not "30.0"."""
    return int(v) if v is not None and float(v).is_integer() else v


def quantity(cell, units):
    """One printed quantity in one of `units`, or None when the cell is not one.

    Returns {value, plusMinus, each, printed}. `value` is null when the letter
    certifies no single figure (two motors and no average); `plusMinus` is null
    when there is none, or when what is printed after the sign is not a number
    ("2.422.06").
    """
    s = cell.strip()
    if not units:
        return None
    unit = '|'.join(re.escape(u) for u in units)
    bracket = None
    m = re.fullmatch(rf'(.*?)\s*\[(?:avg\s*=\s*)?({NUMBER})\s*(?:{unit})\]', s)
    if m:
        s, bracket = m.group(1), number(m.group(2))
    m = re.fullmatch(rf'({NUMBER})\s*±\s*(\S+?)\s*(?:{unit})\*?', s)
    if m:
        return {'value': number(m.group(1)), 'plusMinus': number(m.group(2)), 'each': None, 'printed': cell}
    m = re.fullmatch(rf'({NUMBER})\s*(?:{unit})\*?', s)
    if m:
        return {'value': number(m.group(1)), 'plusMinus': None, 'each': None, 'printed': cell}
    m = re.fullmatch(rf'({NUMBER}(?:,\s+{NUMBER})+)\s*(?:{unit})', s)
    if m:
        each = [number(t) for t in re.split(r',\s+', m.group(1))]
        return {'value': bracket, 'plusMinus': None, 'each': each, 'printed': cell}
    return None


# Each figure: the units its SI cell is printed in (TMT's own spellings, the
# 2025 letters' first), and the units of the imperial cell beside it.
SI = {
    'Diameter': ('mm',),
    'Overall Length': ('mm',),
    'Loaded Mass': ('g',),
    'Propellant Mass': ('g',),
    'Burnout Mass': ('g',),
    'Burn time': ('Seconds', 'sec'),
    'Total Impulse': ('N-sec', 'N.s'),
    'Max Impulse': ('N-Sec', 'N'),
    'Average Impulse': ('N-sec', 'N'),
}
IMPERIAL = {
    'Diameter': ('″',),
    'Overall Length': ('″',),
    'Loaded Mass': ('lbs.', 'lb'),
    'Propellant Mass': ('lbs.', 'lb'),
    'Burnout Mass': ('lbs.', 'lb'),
    'Total Impulse': ('lb.', 'lbf.s'),
    'Max Impulse': ('lb.', 'lbf'),
    'Average Impulse': ('lb-sec.', 'lbf'),
}
# The catalogue's own field names, so the screen compares like with like.
FIELD = {
    'Diameter': 'diameter',
    'Overall Length': 'length',
    'Loaded Mass': 'totalWeightG',
    'Propellant Mass': 'propWeightG',
    'Burnout Mass': 'burnoutWeightG',
    'Burn time': 'burnTimeS',
    'Total Impulse': 'totImpulseNs',
    'Max Impulse': 'maxThrustN',
    'Average Impulse': 'avgThrustN',
}
IMPERIAL_FIELD = {'Total Impulse': 'totImpulseLbfS', 'Max Impulse': 'maxThrustLbf', 'Average Impulse': 'avgThrustLbf'}


PLACEHOLDER = re.compile(r'[?*\s]+')
BARE = re.compile(rf'{NUMBER}\*?')


def split_si_imperial(label, values, where):
    """The SI cell and the imperial cell of one row, told apart by UNIT alone.

    The 2025 letters print "92.5g (0.20 lbs.)" in one cell; the bracketed half is
    the imperial one. A row with two SI cells, or a cell that is neither, stops
    the run: that is a cell read into the wrong column. Two shapes are let
    through and never taken for the SI figure: a placeholder ("?", "*" — the
    letter gives no figure) and, beside an SI cell, a bare number with its unit
    left off ("21.56*" next to "9779 g*", the O5280X-P's propellant in lb).
    """
    cells = []
    for v in values:
        m = re.fullmatch(r'(?:Loaded Weight:\s*)?(.*?)\s*\((.*)\)', v)
        cells.extend([m.group(1), m.group(2)] if m else [v])
    si = imperial = None
    placeholder = bare = False
    for c in cells:
        if PLACEHOLDER.fullmatch(c):
            placeholder = True
            continue
        q = quantity(c, SI[label])
        if q is not None:
            if si is not None:
                raise SystemExit(f'{where}: "{label}" has two SI cells, {si["printed"]!r} and {c!r}')
            si = q
            continue
        q = quantity(c, IMPERIAL.get(label, ()))
        if q is not None:
            if imperial is not None:
                raise SystemExit(f'{where}: "{label}" has two imperial cells, {imperial["printed"]!r} and {c!r}')
            imperial = q
            continue
        if BARE.fullmatch(c):
            bare = True
            continue
        raise SystemExit(f'{where}: "{label}" cell {c!r} is neither SI ({SI[label]}) nor imperial')
    if si is None and placeholder and not bare:
        si = {'value': None, 'plusMinus': None, 'each': None, 'printed': ' '.join(cells)}
    if si is None:
        raise SystemExit(f'{where}: "{label}" has no SI cell in {values!r}')
    return si, imperial


def interpret(rows, where):
    """A letter's row of the table, from its label -> cells map."""
    for label in LABELS:
        if label not in rows:
            raise SystemExit(f'{where}: no "{label}" row')
    desig = rows["Manufacturer's Designation"]
    out = {
        'designation': desig[0],
        'hardware': re.sub(r'™', '', ' '.join(desig[1:] or rows.get(HARDWARE, []))).strip() or None,
        'propellant': re.sub(r'™', '', ' '.join(rows['Propellant'])).strip(),
        'tmtNomenclature': ' '.join(rows['TMT Nomenclature']),
        'motorsTested': int(rows['Number of Motors Tested'][0]),
    }
    plus_minus, imperial, each, printed = {}, {}, {}, {}
    for label, field in FIELD.items():
        si, imp = split_si_imperial(label, rows[label], where)
        out[field] = as_number(si['value'])
        printed[field] = si['printed']
        if si['plusMinus'] is not None:
            plus_minus[field] = as_number(si['plusMinus'])
        if si['each']:
            each[field] = [as_number(v) for v in si['each']]
        if label in IMPERIAL_FIELD and imp is not None:
            imperial[IMPERIAL_FIELD[label]] = as_number(imp['value'])
    out['plusMinus'] = plus_minus
    out['imperial'] = imperial
    if each:
        out['each'] = each
    out['printed'] = printed
    return out


# ------------------------------------------------------------------ letters

MONTH = r'(?:January|February|March|April|May|June|July|August|September|October|November|December)'
LETTER_DATE = re.compile(rf'^(?:{MONTH}\s+\d{{1,2}},\s*\d{{4}}|x+,\s*\d{{4}})$')
TESTED_ON = re.compile(r'tested\s+on\s+(.+?)\s+and\s+(?:complies|is\s+in)')


def letter_facts(plain, where):
    """The date the letter carries, the test date(s) its body states, and who signed it."""
    date = next((l for l in plain if LETTER_DATE.match(l)), None)
    body = ' '.join(plain)
    tested = TESTED_ON.search(body)
    chair = next((plain[i - 1] for i, l in enumerate(plain) if l.startswith('Chair, Tripoli Motor Testing') and i), None)
    if not (date and tested and chair):
        raise SystemExit(f'{where}: letter date {date!r}, test date {tested and tested.group(1)!r}, signed {chair!r}')
    return {'letterDate': date, 'testedOn': tested.group(1), 'signedBy': chair}


def download_urls(cert_docs):
    """Each certification PDF's URL, from the Download-CertDocs.ps1 that fetched it."""
    urls = {}
    script = os.path.join(cert_docs, 'Download-CertDocs.ps1')
    entry = re.compile(r"Case\s*=\s*'([^']*)';\s*Name\s*=\s*'([^']*)';\s*Url\s*=\s*'([^']*)'")
    with open(script, encoding='utf-8') as fh:
        for line in fh:
            m = entry.search(line)
            if not m:
                continue
            case, name, url = m.groups()
            if not case.startswith('TRA\\'):
                continue
            safe = re.sub(r'[\\/:*?"<>|]', '-', name) + '.pdf'
            urls[f'{case[4:]}/{safe}'] = quote(url, safe=':/%')
    return urls


def read_all(source):
    """aerotech-certified.json's content: every 2019-on letter in the folder, and what else it holds."""
    cert_docs = os.path.join(source, 'Cert Docs')
    root = os.path.join(cert_docs, 'TRA')
    urls = download_urls(cert_docs)
    letters, documents, older_text, older_scans = [], 0, 0, 0
    seen_transcribed = set()
    for folder, _dirs, names in sorted(os.walk(root)):
        for name in sorted(names):
            if not name.lower().endswith('.pdf'):
                continue
            documents += 1
            rel = os.path.relpath(os.path.join(folder, name), root).replace(os.sep, '/')
            doc = pymupdf.open(os.path.join(folder, name))
            has_text = any(page.get_text().strip() for page in doc)
            if rel in TRANSCRIBED:
                if has_text:
                    raise SystemExit(f'{rel} now has a text layer: read it, and retire its TRANSCRIBED entry')
                seen_transcribed.add(rel)
                t = TRANSCRIBED[rel]
                row = interpret(t['rows'], rel)
                facts = {k: t[k] for k in ('letterDate', 'testedOn', 'signedBy')}
                read = 'image'
            elif not has_text:
                older_scans += 1
                continue
            else:
                rows, plain = text_rows(doc, rel)
                # The row only this form has. A page that has it and lacks another
                # row stops the run in `interpret`, rather than dropping out of the
                # table unremarked.
                if "Manufacturer's Designation" not in rows:
                    older_text += 1
                    continue
                row = interpret(rows, rel)
                facts = letter_facts(plain, rel)
                read = 'text'
            if rel not in urls:
                raise SystemExit(f'{rel}: not in Download-CertDocs.ps1, so its URL is unknown')
            letters.append({'file': rel, 'url': urls[rel], 'read': read, **facts, **row})
    missing = sorted(set(TRANSCRIBED) - seen_transcribed)
    if missing:
        raise SystemExit(f'TRANSCRIBED names files that are not in {root}: {missing}')
    return {
        'source': 'Tripoli Motor Testing certification letters for AeroTech (RCS Rocket Motor Components) motors',
        'publishedOn': PUBLISHED_ON,
        'folder': 'docs/RCS Schematics/Cert Docs/TRA (local-only)',
        'extractedBy': 'packages/app/scripts/extract-aerotech-certified.py',
        'documents': documents,
        'letters': len(letters),
        'readFromImage': sum(1 for l in letters if l['read'] == 'image'),
        'olderForms': {'withText': older_text, 'scans': older_scans},
        'rows': letters,
    }


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--source', default=os.environ.get('RCS_SCHEMATICS', DEFAULT_SOURCE))
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--check', action='store_true')
    args = ap.parse_args(argv)
    text = json.dumps(read_all(args.source), ensure_ascii=False, indent=2) + '\n'
    if args.check:
        with open(args.out, encoding='utf-8') as fh:
            same = fh.read() == text
        print('aerotech-certified.json is what the letters give' if same else
              'aerotech-certified.json DIFFERS from what the letters give: re-run without --check')
        return 0 if same else 1
    with open(args.out, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    print(f'wrote {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
