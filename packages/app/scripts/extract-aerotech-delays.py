"""
AeroTech's published measured ejection delays and printed averages, read into
src/data/aerotechDelays.json: what the launch report shows beside a delay the
certification tests fired (Eric's ruling of 2026-09-08, "yes" to the
delay-time band; docs/research/aerotech-document-set-2026-09-08.md section 4).

WHY. The app fires an ejection charge exactly at the delay it is given. A real
5-second delay is not that: the F52C's TRA letter measured its 5 s delay at
4.946, 4.507 and 5.158 s. A certification test fires each delay setting a few
times and prints what each charge did; that sample is an honest basis for
saying how early or late the charge may fire. It is a sample of test motors,
not a guarantee, and the report says so.

WHAT IS READ. `Cert Docs/NAR` and `Cert Docs/TRA` under `docs/RCS Schematics`
(local-only, gitignored): the certification documents AeroTech's maker, RCS
Rocket Motor Components, links from its own page (PUBLISHED_ON), fetched by the
folder's Download-CertDocs.ps1, whose list gives each file's URL. Individual
measured samples come only from documents printing EACH motor's delay:

  - TMT letters (TRA, 2019 on): a "Delay Time Data" row, one line per nominal
    delay, "5 s | 4.946, 4.507, 5.158 s".
  - NAR test reports (2005 to 2017): a table with one row per motor fired, its
    designation carrying the delay it was sold with ("E20-4W", "F51-NT-10",
    "G53-10FJ") and a Delay (or T-DELAY) column holding what it measured.

The 44 reviewed average-only scans supply printed averages separately from
individual measurements (Eric's 2026-11-15 ruling); they supply no spread.
Text-layer average-only NAR summaries and TRA letters are read by word
coordinates too, never as individual measurements. --text-average-inventory
enumerates every eligible document and rejection reason, with NAR/TRA document
and nominal counts (no heuristic inventory count is treated as evidence).
Measured 2026-11-16 (row 133): 16 documents, 40 nominals (10 NAR summaries /
24, 6 TRA "Delay Performance (labeled/tested)" letters / 16); AVERAGE_JOIN
leaves 3 of them unjoined, so 13 motors / 33 nominals ship from text.
The 101 scans with
no text layer use the reviewed, source-positioned transcriptions beside this
script. A scan needs an agreeing delay average or repeated summary; a count
of motors tested alone does not verify a manually read value (b10 DELAY).

NEVER FROM FLATTENED TEXT (CLAUDE.md). `page.get_text()` returns labels and
values as separate runs, and an empty cell lets the next column slide into its
place (three NAR rows print no delay: "NO DATA", "FIX CURVE", a blank). Every
word here keeps its position: words whose vertical centres lie within
ROW_TOLERANCE_PT form a row, and in a NAR table the measured delay is the word
standing under the table's own Delay heading, by x coordinate, never the n-th
cell of the row. A row with nothing under that heading is counted as "no data",
never filled from its neighbour.

CHECKED AGAINST THE DOCUMENT ITSELF. A NAR report prints its delays more than
once: the motor table, an average per nominal (the summary above the curve),
and in most a summary that prints each motor's delay again. The values read for
each nominal must average to the printed average and reappear in that summary,
within PRINT_TOLERANCE_S, or the run stops; a value read from the wrong column
cannot pass either. Two documents disagree with themselves and are named, with
what was found, in AVERAGE_DISAGREES and DISPUTED; a DISPUTED delay ships
nothing. A TMT letter prints its delays once, and the number read must not
exceed its "Number of Motors Tested".

KEYED BY THE MOTOR DATABASE. Each document is joined BY HAND (JOIN) to the
catalogue row it certifies, and the shipped file is keyed by that row's
thrustcurve.org motorId, the key src/data/motors.json carries. The run refuses
a JOIN whose designation is not in the catalogue, or a document with measured
delays that has no JOIN entry, so a catalogue refresh that drops or renames a
motor stops this run instead of shipping a dangling key. RUN IT AFTER
fetch-motor-db.mjs (motors.json), in the same sitting as any motors refresh.

Usage:
  python extract-aerotech-delays.py [--source "<RCS Schematics folder>"] [--motors <motors.json>] [--out <file>] [--check] [--join <file>] [--average-join <file>] [--transcriptions <file>] [--watch-out <file>]

--source defaults to $RCS_SCHEMATICS, then to the repo's docs/RCS Schematics.
--motors defaults to src/data/motors.json. --out defaults to
src/data/aerotechDelays.json. --check compares instead of writing, and exits 1
when the committed file is not what the documents give. --join replaces the
JOIN table with a JSON file's (the tests' synthetic documents).
--transcriptions defaults to aerotech-delay-transcriptions.json beside this
script. Accepted `documents` carry manufacturer/designation, the PDF's SHA-256,
and delays whose `measurements` and `crossChecks` preserve printed strings and
1-based page / row / column positions. `unread` entries carry reasons and may
hold candidate values, which never enter the shipped bands. Reviewed
`printedAverages` enter only `averages`, never `motors` or `measuredS`.
--average-join replaces AVERAGE_JOIN for synthetic-document checks.
--text-average-inventory prints the coordinate-read inventory without joining
or writing data; every discovered document still needs a reviewed AVERAGE_JOIN
before regeneration. textAverageReview records the exact counts and positions.
--watch-out also writes (or, with --check, compares) the upstream-watch snapshot:
all published PDF URLs from the downloader, plus hashes of shipped delay source
documents and withheld individual-sample scans. Run it in the same regeneration.
"""
import argparse
import hashlib
import json
import os
import re
import sys
from atomic_write import atomic_write
from reference_docs import reference_dir
from urllib.parse import quote

# `import pymupdf`, not `import fitz` (extract-nozzle-pdfs.py: the old name's
# deprecation warning goes to stdout).
import pymupdf

pymupdf.set_messages(stream=sys.stderr)

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MOTORS = os.path.join(HERE, '..', 'src', 'data', 'motors.json')
DEFAULT_OUT = os.path.join(HERE, '..', 'src', 'data', 'aerotechDelays.json')
DEFAULT_TRANSCRIPTIONS = os.path.join(HERE, 'aerotech-delay-transcriptions.json')

# The manufacturer's own page linking every document read here (read 2026-10-01).
PUBLISHED_ON = 'https://www.rocketmotorparts.com/page/nar-tra-certification-docs'

# Each document with measured delays -> the catalogue row it certifies, as
# (manufacturerAbbrev, designation) in src/data/motors.json. Matched by hand
# from the document's own designation, case, propellant and impulse; the note
# says why where the names differ.
JOIN = {
    'NAR/24mm Model Rocket Single-Use/E20W.pdf': ('AeroTech', 'E20W'),
    'NAR/24mm Model Rocket Single-Use/F30FJ.pdf': ('AeroTech', 'F30FJ'),
    'NAR/24mm Model Rocket Single-Use/F32T.pdf': ('AeroTech', 'F32T'),
    'NAR/24mm Model Rocket Single-Use/F44W.pdf': ('AeroTech', 'F44W'),
    'NAR/29mm High Power Single-Use/G142.pdf': ('AeroTech', 'G142'),
    'NAR/29mm Model Rocket Single-Use/F26FJ.pdf': ('AeroTech', 'F26FJ'),
    # The catalogue's only F42T is the LMS ("/L") row; the report is AeroTech's F42.
    'NAR/29mm Model Rocket Single-Use/F42T.pdf': ('AeroTech', 'F42T/L'),
    'NAR/29mm Model Rocket Single-Use/F67W.pdf': ('AeroTech', 'F67W'),
    'NAR/29mm Model Rocket Single-Use/G74W.pdf': ('AeroTech', 'G74W'),
    # "pre-assembled and LMS versions": the catalogue carries it as G78G/L.
    'NAR/29mm Model Rocket Single-Use/G78G (pre-assembled and LMS versions).pdf': ('AeroTech', 'G78G/L'),
    'NAR/29mm Model Rocket Single-Use/G80T (New 137 N-sec Version).pdf': ('AeroTech', 'G80T'),
    # Kosdon by AeroTech: thrustcurve.org files them under KBA.
    'NAR/Kosdon by AeroTech Animal-Compatible (KBA A-C) KBA A-C 38-640/I301W-18.pdf': ('KBA', 'I301W'),
    'NAR/Kosdon by AeroTech Animal-Compatible (KBA A-C) KBA A-C 38-640/I550R-20.pdf': ('KBA', 'I550R'),
    'NAR/RMS-24-60/F35W.pdf': ('AeroTech', 'F35W'),
    'NAR/RMS-24-60/F51NT.pdf': ('AeroTech', 'F51NT'),
    'NAR/RMS-24-60/F62FJ.pdf': ('AeroTech', 'F62FJ'),
    'NAR/RMS-24-60/F63R.pdf': ('AeroTech', 'F63R'),
    'NAR/RMS-29-40-120/G53FJ.pdf': ('AeroTech', 'G53FJ'),
    'NAR/RMS-29-40-120/G76G.pdf': ('AeroTech', 'G76G'),
    # AeroTech makes the Q-Jets; thrustcurve.org files the 18 mm ones under Quest.
    'TRA/18mm Quest Single Use/Quest Q-Jet B6-4, 6W.pdf': ('Quest', 'B6W'),
    'TRA/18mm Quest Single Use/Quest Q-Jet C18-4, 6, 8W.pdf': ('Quest', 'C18W'),
    'TRA/18mm Quest Single Use/Quest Q-Jet D20-4, 6, 8W.pdf': ('Quest', 'D20W'),
    'TRA/24mm Quest Single Use/Quest Q-Jet D22-4, 7, 10W.pdf': ('AeroTech', 'D22W'),
    'TRA/24mm Quest Single Use/Quest Q-Jet E26-4, 7, 10W.pdf': ('AeroTech', 'E26W'),
    'TRA/29mm High Power Single-Use/G72DM-14A DMS.pdf': ('AeroTech', 'G72DM-14A'),
    'TRA/29mm High Power Single-Use/G75M-13A DMS.pdf': ('AeroTech', 'G75M'),
    'TRA/29mm High Power Single-Use/H169WS-13A DMS.pdf': ('AeroTech', 'H169WS-13'),
    'TRA/29mm Model Rocket Single Use/E24-4, 7, 10C.pdf': ('AeroTech', 'E24C'),
    'TRA/29mm Model Rocket Single Use/F52-5, 8, 11C.pdf': ('AeroTech', 'F52C'),
    'TRA/29mm Model Rocket Single Use/F67-6, 9, 14C.pdf': ('AeroTech', 'F67C'),
    'TRA/38mm High Power Single-Use/I175WS-13A DMS.pdf': ('AeroTech', 'I175WS'),
    'TRA/54mm High Power Single-Use/K455NW-17A DMS.pdf': ('AeroTech', 'K455NW-17'),
}

# Average-only documents: hand joins use the same designation/case/propellant
# rules as JOIN. None means the catalogue cannot identify this motor safely.
AVERAGE_JOIN = {
    'NAR/18mm Model Rocket Single-Use/D21T.pdf': ('AeroTech', 'D21T'),
    'NAR/18mm Model Rocket Single-Use/E25T.pdf': None,
    'NAR/18mm Model Rocket Single-Use/E45T.pdf': None,
    'NAR/24mm Model Rocket Single-Use/E15W.pdf': ('AeroTech', 'E15W'),
    # Old case vs new thrust-ring case: the catalogue designation alone cannot
    # establish which certified case its E30T represents.
    'NAR/24mm Model Rocket Single-Use/E30T.pdf': None,
    'NAR/24mm Model Rocket Single-Use/E6T.pdf': None,
    'NAR/24mm Model Rocket Single-Use/F32W.pdf': ('AeroTech', 'F32W'),
    'NAR/24mm Model Rocket Single-Use/F44 Classic.pdf': None,
    'NAR/24mm Model Rocket Single-Use/F72T.pdf': None,
    'NAR/24mm Model Rocket Single-Use/G42W.pdf': None,
    'NAR/24mm Model Rocket Single-Use/G55W.pdf': None,
    'NAR/29mm Model Rocket Single-Use/F10T.pdf': None,
    'NAR/29mm Model Rocket Single-Use/F14J.pdf': None,
    # The catalogue's Econojet F20 is the LMS /L row, as with JOIN's F42.
    'NAR/29mm Model Rocket Single-Use/F20W.pdf': ('AeroTech', 'F20W/L'),
    'NAR/29mm Model Rocket Single-Use/F25W.pdf': ('AeroTech', 'F25W'),
    'NAR/29mm Model Rocket Single-Use/F50T.pdf': ('AeroTech', 'F50T'),
    # Discontinued single-use motor; the catalogue G25W is an RMS-29/120 reload.
    'NAR/29mm Model Rocket Single-Use/G25W.pdf': None,
    # The catalogue's G35 is this SU 29x98 Econojet: same 100.82 N-s, 76.22 N peak and
    # 2.91 s burn as the 1996 report (archive.org copy, added 2026-11-18).
    'NAR/29mm Model Rocket Single-Use/G35W.pdf': ('AeroTech', 'G35'),
    'NAR/29mm Model Rocket Single-Use/G40W.pdf': ('AeroTech', 'G40W'),
    # Old G80: measured data for the new 137 N-sec version wins.
    'NAR/29mm Model Rocket Single-Use/G80T.pdf': None,
    'NAR/RMS-18-20/C12T.pdf': None,
    'NAR/RMS-18-20/C6W.pdf': None,
    'NAR/RMS-18-20/D13W.pdf': ('AeroTech', 'D13W'),
    'NAR/RMS-18-20/E27T.pdf': None,
    'NAR/RMS-24-40/D15T.pdf': ('AeroTech', 'D15T'),
    'NAR/RMS-24-40/D9W.pdf': ('AeroTech', 'D9W'),
    'NAR/RMS-24-40/E11J.pdf': ('AeroTech', 'E11J'),
    'NAR/RMS-24-40/E18W.pdf': ('AeroTech', 'E18W'),
    'NAR/RMS-24-40/E28T.pdf': ('AeroTech', 'E28T'),
    'NAR/RMS-24-40/F12J.pdf': ('AeroTech', 'F12J'),
    'NAR/RMS-24-40/F24W.pdf': ('AeroTech', 'F24W'),
    'NAR/RMS-24-40/F39T.pdf': ('AeroTech', 'F39T'),
    'NAR/RMS-29-100/G54W.pdf': ('AeroTech', 'G54W'),
    'NAR/RMS-29-240/H220T.pdf': ('AeroTech', 'H220T'),
    'NAR/RMS-29-40-120/E16W.pdf': ('AeroTech', 'E16W'),
    'NAR/RMS-29-40-120/F22J.pdf': ('AeroTech', 'F22J'),
    'NAR/RMS-29-40-120/F40W.pdf': ('AeroTech', 'F40W'),
    'NAR/RMS-29-40-120/F52T.pdf': ('AeroTech', 'F52T'),
    'NAR/RMS-29-40-120/G33J.pdf': None,
    'NAR/RMS-29-40-120/G64W.pdf': ('AeroTech', 'G64W'),
    'NAR/RMS-29-60/F37W.pdf': ('AeroTech', 'F37W'),
    'NAR/RMS-38-480/I300T.pdf': ('AeroTech', 'I300T'),
    'TRA/RMS-29-100/G54W.pdf': ('AeroTech', 'G54W'),
    'TRA/RMS-29-60/F37W.pdf': ('AeroTech', 'F37W'),
    # Text-layer averages (row 133, reviewed 2026-11-16 against motors.json:
    # every printed nominal is one of the joined row's catalogue delays).
    'NAR/18mm Model Rocket Single-Use/D10W.pdf': ('AeroTech', 'D10W'),
    # As the scanned E30T above: the catalogue cannot say which case it is.
    'NAR/24mm Model Rocket Single-Use/E30T (new thrust ring case).pdf': None,
    # Two catalogue rows (F23FJ and F23FJ/L); the sheet does not say which.
    'NAR/29mm Model Rocket Single-Use/F23FJ.pdf': None,
    # The catalogue's only F27R is the LMS /L row, as with F42 and F20.
    'NAR/29mm Model Rocket Single-Use/F27R.pdf': ('AeroTech', 'F27R/L'),
    'NAR/29mm Model Rocket Single-Use/G38FJ.pdf': ('AeroTech', 'G38FJ'),
    # A single-use sheet: the catalogue's single-use G77R is the /L row.
    'NAR/29mm Model Rocket Single-Use/G77R.pdf': ('AeroTech', 'G77R/L'),
    # The sheet contradicts itself: "Delays: 4, 7, 10" in its header, but
    # 4, 8, 10 over the averages it prints, so which nominal 6.10 s belongs
    # to cannot be told from the document. Withheld whole.
    'NAR/29mm Model Rocket Single-Use/G79W.pdf': None,
    'NAR/RMS-18-20/D24T.pdf': ('AeroTech', 'D24T'),
    'NAR/RMS-29-40-120/E23T.pdf': ('AeroTech', 'E23T'),
    'NAR/RMS-29-40-120/G71R.pdf': ('AeroTech', 'G71R'),
    # Quest Q-Jet letters filed with AeroTech's TRA documents; the catalogue
    # lists them under Quest. A3 and B4 (4, 6 s) are the current rows, not
    # the out-of-production A3T (2, 4 s) or B4-4 (4 s only).
    'TRA/18mm Quest Single Use/Quest Q-Jet A3-4, 6FJ.pdf': ('Quest', 'A3'),
    'TRA/18mm Quest Single Use/Quest Q-Jet B4-4, 6FJ.pdf': ('Quest', 'B4'),
    'TRA/18mm Quest Single Use/Quest Q-Jet C12-4, 6, 8FJ.pdf': ('Quest', 'C12'),
    'TRA/18mm Quest Single Use/Quest Q-Jet D16-4, 6, 8FJ.pdf': ('Quest', 'D16'),
    'TRA/38mm High Power Single-Use/J435WS-14A DMS.pdf': ('AeroTech', 'J435WS'),
    'TRA/RMS-38-1080/J520-13A RMS-EZ.pdf': ('AeroTech', 'J520W'),
}

# (manufacturer, designation) -> nominals whose independent printed averages
# disagree. Checked both ways: corrected documents must lose their exception.
AVERAGE_DISPUTED = {}

ROW_TOLERANCE_PT = 3.0
CELL_GAP_PT = 12.0
# A NAR report's summary prints to two decimals what its motor table prints to
# two or three: half a unit in the last place, and a hair for float error.
PRINT_TOLERANCE_S = 0.0051

# A NAR report prints its measurements more than once: the motor table, then a
# summary of averages per nominal and (in most) each motor's delay again. The
# run stops wherever they disagree, unless the document is named here with what
# was found. Each entry is checked both ways: the run also stops when the
# document turns out to agree, so a corrected document does not keep its excuse.
#
# AVERAGE_DISAGREES: the printed average is not the average of the printed
# values, but the values agree in both places, so the values are taken.
AVERAGE_DISAGREES = {
    # Motor table and summary both print 3.398, 3.894, 3.606, 3.500 (mean 3.600)
    # and 7.890, 8.526, 7.680, 9.234 (mean 8.333); the averages read 3.646/3.65
    # and 8.208/8.21.
    'NAR/24mm Model Rocket Single-Use/F44W.pdf': {4, 8},
    # The 9 s values average to their printed 9.75; 4 s and 6 s are DISPUTED below.
    'NAR/29mm Model Rocket Single-Use/F67W.pdf': {4, 6},
}
# DISPUTED: the motor table and the summary print DIFFERENT measurements for
# the same nominal, so there is no one published figure, and none is shipped
# for that delay. The F67W's motor table reads 4 s as 4.122, 4.640, 4.668 and
# 6 s as 6.016, 6.476, 6.184, 6.184; its summary reads them 3.19, 3.08, 3.43
# (avg 3.23) and 5.51, 5.55, 6.32 (avg 5.79). Its 9 s agrees in both.
DISPUTED = {
    'NAR/29mm Model Rocket Single-Use/F67W.pdf': {4, 6},
}


def tidy(text):
    return re.sub(r'\s+', ' ', text).strip()


def word_rows(doc):
    """Every visual line of the document, page by page, as its words (x0, x1, text) left to right.

    Words whose vertical centres lie within ROW_TOLERANCE_PT of the line's
    running centre are one line (extract-aerotech-certified.py's rule).
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
            out.append([(w[0], w[2], w[4]) for w in row])
    return out


def cells(row):
    """A row's words as cells: a gap wider than CELL_GAP_PT starts a new one."""
    out, cell, right = [], [], None
    for x0, x1, text in row:
        if right is not None and x0 - right > CELL_GAP_PT:
            out.append(tidy(' '.join(cell)))
            cell = []
        cell.append(text)
        right = x1
    if cell:
        out.append(tidy(' '.join(cell)))
    return out


NUMBER = re.compile(r'^\d*\.\d+$|^\d+$')


def num(text):
    return float(text) if NUMBER.match(text) else None


def as_number(v):
    return int(v) if float(v).is_integer() else v


# ---------------------------------------------------------------- TMT letters

NOMINAL_CELL = re.compile(r'^(\d+) s$')
VALUES_CELL = re.compile(r'^((?:\d*\.\d+|\d+)(?:,?\s*(?:\d*\.\d+|\d+))*)\s*s$')


def tmt_delays(rows, where):
    """{nominal: [measured, ...]} from a TMT letter's "Delay Time Data" row, or None when it has none.

    The label cell holds the first line ("Delay Time Data | 5 s | 4.946, 4.507,
    5.158 s"); each further nominal is a line of its own with the label column
    empty. "n.a." (a plugged motor) is no data.
    """
    out = None
    for i, row in enumerate(rows):
        c = cells(row)
        if c[0] != 'Delay Time Data':
            continue
        if out is not None:
            raise SystemExit(f'{where}: two "Delay Time Data" rows')
        out = {}
        lines = [c[1:]] + [cells(r) for r in rows[i + 1:]]
        for line in lines:
            if len(line) != 2 or not NOMINAL_CELL.match(line[0]):
                break
            m = VALUES_CELL.match(line[1])
            if not m:
                raise SystemExit(f'{where}: delay cell {line[1]!r} beside {line[0]!r} is not a list of seconds')
            nominal = int(NOMINAL_CELL.match(line[0]).group(1))
            if nominal in out:
                raise SystemExit(f'{where}: nominal {nominal} s twice')
            out[nominal] = [float(t) for t in re.findall(r'\d*\.\d+|\d+', m.group(1))]
    return out


def tmt_motors_tested(rows):
    for row in rows:
        c = cells(row)
        if c[0] == 'Number of Motors Tested' and len(c) == 2 and c[1].isdigit():
            return int(c[1])
    return None


# ---------------------------------------------------------------- NAR reports

# The table's measured-delay heading; "Delay" alone where no "t-Delay" is beside it.
DELAY_HEAD = re.compile(r'^(?:t-)?delay$', re.I)
BURN_HEAD = re.compile(r'^(?:t-)?burn$', re.I)
# A fired motor's designation with the delay it was sold with: E20-4W, G53-10FJ,
# F51-NT-10, F62FJ-10, I301W-18, G74-4, K750W-P (P: plugged).
DESIGNATION = re.compile(r'^[A-O]\d+[A-Z]*(?:-[A-Z]+)?-(\d+|P)[A-Z]*$')
TABLE_END = re.compile(r'^(?:average|avg)$', re.I)


def nar_tables(rows, where):
    """Each per-motor table of a NAR report: its fired motors as (nominal or 'P', measured or None).

    The measured delay is the word whose horizontal centre falls inside the
    Delay heading's span widened by half a cell gap: the column under the
    heading, read by position. A row with nothing there (G74W's last motor, F62FJ's
    "NO DATA", F63R's "FIX CURVE") is None.
    """
    tables = []
    i = 0
    while i < len(rows):
        row = rows[i]
        heads = [w for w in row if DELAY_HEAD.match(w[2])]
        if not heads or not any(BURN_HEAD.match(w[2]) for w in row):
            i += 1
            continue
        timed = [w for w in heads if w[2].lower().startswith('t-')]
        head = (timed or heads)[0]
        lo, hi = head[0] - CELL_GAP_PT / 2, head[1] + CELL_GAP_PT / 2
        fired = []
        i += 1
        while i < len(rows) and not TABLE_END.match(rows[i][0][2]):
            words = rows[i]
            desig = [w for w in words if DESIGNATION.match(w[2])]
            if desig:
                if len(desig) != 1:
                    raise SystemExit(f'{where}: two designations in one row: {[w[2] for w in desig]}')
                nominal = DESIGNATION.match(desig[0][2]).group(1)
                nominal = 'P' if nominal == 'P' else int(nominal)
                under = [w for w in words if lo <= (w[0] + w[1]) / 2 <= hi]
                if len(under) > 1:
                    raise SystemExit(f'{where}: two words under the Delay heading: {[w[2] for w in under]}')
                measured = num(under[0][2]) if under else None
                if under and measured is None and under[0][2].lower() not in ('plugged', 'p', 'data'):
                    raise SystemExit(f'{where}: {under[0][2]!r} under the Delay heading')
                fired.append((nominal, measured))
            i += 1
        tables.append(fired)
    return tables


def nar_averages(rows):
    """{nominal: average measured delay} from a NAR report's summary block, in its three layouts; {} when it has none."""
    out = {}
    plain = [cells(r) for r in rows]
    for i, c in enumerate(plain):
        # "Delay Time(sec.) | 4 | 7 | 10" ... "Delay(sec.) | 4.69 | 6.75 | 10.26"
        # "Delay Time (sec) | 4 | 7" ... "Avg. Measured Delay | 4.34 | 7.16"
        if re.match(r'^Delay Time ?\(sec\.?\)$', c[0]) and len(c) > 1 and all(t.isdigit() for t in c[1:]):
            nominals = [int(t) for t in c[1:]]
            for d in plain[i + 1:i + 4]:
                if d[0] in ('Delay(sec.)', 'Avg. Measured Delay') and len(d) == len(c):
                    for n, a in zip(nominals, d[1:]):
                        if num(a) is not None:
                            out[n] = float(a)
                    break
        # "Delay Time | Measured Delay | Initial Mass ..." then "4 | 3.65 | 48.5 g"
        if c[:2] == ['Delay Time', 'Measured Delay']:
            for d in plain[i + 1:]:
                if len(d) < 2 or not d[0].isdigit() or num(d[1]) is None:
                    break
                out[int(d[0])] = float(d[1])
    return out


def column_bounds(heads):
    """Coordinate bounds for each heading's column.

    Bounds are halfway between heading centres. The outer columns extend by
    half the nearest column spacing, or half a cell gap for a single heading.
    """
    centres = [(w[0] + w[1]) / 2 for w in heads]
    bounds = []
    for i, centre in enumerate(centres):
        lo = (centres[i - 1] + centre) / 2 if i else centre - (
            (centres[1] - centre) / 2 if len(centres) > 1 else CELL_GAP_PT / 2 + heads[i][1] - heads[i][0])
        hi = (centre + centres[i + 1]) / 2 if i + 1 < len(centres) else centre + (
            (centre - centres[i - 1]) / 2 if i else CELL_GAP_PT / 2 + heads[i][1] - heads[i][0])
        bounds.append((lo, hi))
    return bounds


def aligned_numbers(heads, row, count=None):
    """Read one number per column, optionally only the first count columns."""
    out = []
    for lo, hi in column_bounds(heads)[:count]:
        words = [w for w in row if lo <= (w[0] + w[1]) / 2 < hi]
        if len(words) != 1 or num(words[0][2]) is None:
            return None
        out.append(float(words[0][2]))
    return out


def nar_text_averages(rows, positions=None):
    """NAR summary averages, requiring a complete, position-matched summary.

    nar_averages recognises the existing summary layouts; this additional
    coordinate check prevents equal cell counts from disguising a blank column.
    """
    out = {}
    for i, row in enumerate(rows):
        c = cells(row)
        if re.match(r'^Delay Time ?\(sec\.?\)$', c[0]):
            heads = [w for w in row if w[2].isdigit()]
            if not heads:
                return {}, 'NAR summary has no nominal columns'
            candidates = [r for r in rows[i + 1:i + 4]
                          if cells(r)[0] in ('Delay(sec.)', 'Avg. Measured Delay')]
            if len(candidates) != 1:
                return {}, 'NAR summary has no unique average row'
            values = aligned_numbers(heads, candidates[0])
            if values is None:
                return {}, 'NAR summary has a blank or ambiguous average column'
            if dict(zip((int(h[2]) for h in heads), values)) != nar_averages(rows[i:i + 4]):
                return {}, 'NAR summary cells disagree with coordinate columns'
            for column, (head, value) in enumerate(zip(heads, values), 1):
                n = int(head[2])
                if n in out:
                    return {}, 'NAR summary repeats a nominal'
                out[n] = value
                if positions is not None:
                    positions.append({'nominalS': n, 'row': i + 2 + rows[i + 1:i + 4].index(candidates[0]),
                                      'column': column, 'xPt': head[0]})
        elif c[:2] == ['Delay Time', 'Measured Delay']:
            # Locate the two labelled column spans, not the second nonempty cell.
            heads = []
            for label in ('Delay Time', 'Measured Delay'):
                words = label.split()
                spans = [(row[k][0], row[k + 1][1], label) for k in range(len(row) - 1)
                         if [w[2] for w in row[k:k + 2]] == words]
                if len(spans) != 1:
                    return {}, 'NAR summary has ambiguous headings'
                heads.extend(spans)
            # Preserve the next heading's span to bound Measured Delay, even
            # though its column (often mass) is not a delay value to read.
            following = [w for w in row if w[0] > heads[1][1]]
            if following:
                end = 1
                while end < len(following) and following[end][0] - following[end - 1][1] <= CELL_GAP_PT:
                    end += 1
                heads.append((following[0][0], following[end - 1][1], 'next heading'))
            lo, hi = column_bounds(heads)[0]
            lo = max(lo, heads[0][0] - CELL_GAP_PT / 2)
            m_lo, m_hi = column_bounds(heads)[1]
            last_read = i
            for row_idx, r in enumerate(rows[i + 1:], i + 1):
                nominal_words = [w for w in r if lo <= (w[0] + w[1]) / 2 < hi]
                # A row with no whole-number Delay Time cell, or nothing right
                # of that column, ends the table: on the real sheets the thrust
                # curve's axis labels (25, 20, 15, ...) sit under that column
                # just below it. A row with a later column filled but no
                # Measured Delay is a blank cell, and withholds the sheet below.
                right = [w for w in r if (w[0] + w[1]) / 2 >= hi]
                if not nominal_words or not nominal_words[0][2].isdigit() or not right:
                    # Only a true end of table may stop here (closure reviews
                    # r2/r3): if a later row on the page still reads as a table
                    # row (one positive whole number under Delay Time and a
                    # number as the first cell right of it; real rows go on with
                    # mass columns and unit words, e.g. D10W's "7 7.82 25.9 g
                    # 300 g"), the row that stopped the scan was
                    # a broken table row, not a chart label, so withhold the
                    # sheet rather than ship the rows above it. Limit: a broken
                    # LAST row with nothing to its right looks exactly like an
                    # axis label (rows carry no y-coordinate) and is not caught;
                    # but the row straight after the last one read, with a value
                    # under Measured Delay and no whole-number delay beside it,
                    # is a broken row whatever follows (closure review r4).
                    m_words = [w for w in r if m_lo <= (w[0] + w[1]) / 2 < m_hi]
                    if (row_idx == last_read + 1 and (not nominal_words or not nominal_words[0][2].isdigit())
                            and len(m_words) == 1 and num(m_words[0][2]) is not None):
                        return {}, 'NAR summary has an incomplete row'
                    for later in rows[row_idx + 1:]:
                        n_words = [w for w in later if lo <= (w[0] + w[1]) / 2 < hi]
                        r_words = [w for w in later if (w[0] + w[1]) / 2 >= hi]
                        if (len(n_words) == 1 and n_words[0][2].isdigit() and int(n_words[0][2]) > 0
                                and r_words and num(min(r_words)[2]) is not None):
                            return {}, 'NAR summary has an incomplete row'
                    break
                values = aligned_numbers(heads, [w for w in r if (w[0] + w[1]) / 2 >= lo], count=2)
                if values is None or not values[0].is_integer() or int(values[0]) in out:
                    return {}, 'NAR summary has a blank, duplicate or ambiguous value'
                out[int(values[0])] = values[1]
                last_read = row_idx
                if positions is not None:
                    positions.append({'nominalS': int(values[0]), 'row': row_idx + 1,
                                      'column': 2, 'xPt': heads[1][0]})
    return out, None if out else 'no NAR average summary'


TRA_DELAY_LINE = re.compile(r'delay\s+performance\s*\(\s*label{1,2}ed\s*/\s*tested(?:\s+average)?\s*\)', re.I)
TRA_DELAY_PAIR = re.compile(r'\s*,?\s*(\d+)\s*sec\s*=\s*(\d+(?:\.\d+)?)(?:\s*sec)?', re.I)


def tra_averages(rows, positions=None):
    """({nominal: average}, reason) from a TRA letter's Delay Performance line.

    Every TRA letter in the AeroTech folders that prints delays (six, counted
    2026-11-16) prints them on ONE visual row, e.g.
    "Delay Performance (labeled/tested) 8 sec=8.7 sec, 6 sec=5.7 sec, 4 sec=4.8 sec"
    ("labeled/tested average" on some). Each value is paired with its nominal
    in the text itself, so no table column can slide. The rest of that row
    must be wholly such pairs; anything else, a second such line, a repeated
    nominal or a value that cannot be placed withholds the letter.
    """
    out, found = {}, False
    for row_index, row in enumerate(rows, 1):
        text = ' '.join(w[2] for w in row)
        label = TRA_DELAY_LINE.search(text)
        if not label:
            continue
        if found:
            return {}, 'TRA letter repeats its Delay Performance line'
        found = True
        rest, at, pairs = text[label.end():], 0, []
        for pair in TRA_DELAY_PAIR.finditer(rest):
            if pair.start() != at:
                return {}, 'TRA Delay Performance line has text between its pairs'
            pairs.append((pair.group(1), pair.group(2), label.end() + pair.start(2)))
            at = pair.end()
        if rest[at:].strip(' ,.;'):
            return {}, 'TRA Delay Performance line has text after its pairs'
        if not pairs:
            return {}, 'TRA Delay Performance line has no nominal = average pairs'
        # Skip every word in the label, then move only forward through values.
        offset, after_label, word_offsets = 0, 0, []
        for index, word in enumerate(row):
            if offset < label.end():
                after_label = index + 1
            word_offsets.append((offset, offset + len(word[2])))
            offset += len(word[2]) + 1
        after_value = after_label
        for column, (nominal, printed, value_offset) in enumerate(pairs, 1):
            n = int(nominal)
            if n <= 0 or n in out:
                return {}, 'TRA delay row has a duplicate or invalid nominal'
            place = next((i for i in range(after_value, len(row))
                          if word_offsets[i][0] <= value_offset < word_offsets[i][1]
                          and re.search(r'(?:^|=)' + re.escape(printed) + r'$', row[i][2].rstrip(',.;'))), None)
            if place is None:
                return {}, 'TRA delay value cannot be placed on its row'
            after_value = place + 1
            out[n] = float(printed)
            if positions is not None:
                positions.append({'nominalS': n, 'row': row_index, 'column': column, 'xPt': row[place][0]})
    return out, None if out else 'no TRA labeled / tested average rows'


def text_averages(path):
    """Read only coordinate evidence, retaining source pages for the inventory."""
    with pymupdf.open(path) as doc:
        pages = [word_rows([page]) for page in doc]
    found, positions = {}, []
    reasons = []
    for page, rows in enumerate(pages, 1):
        source_positions = []
        averages, reason = nar_text_averages(rows, source_positions)
        reader = 'nar'
        if not averages and reason == 'no NAR average summary':
            averages, reason = tra_averages(rows, source_positions)
            reader = 'tra'
        if reason:
            reasons.append(f'page {page}: {reason}')
            if reason not in ('no NAR average summary', 'no TRA labeled / tested average rows'):
                return {}, {'reason': '; '.join(reasons)}
        if averages and found and (reader == 'tra' or any(p['reader'] == 'tra' for p in positions)):
            return {}, {'reason': f'page {page}: TRA letter repeats its Delay Performance line or mixes readers'}
        for nominal, value in averages.items():
            if (type(nominal) is not int or nominal <= 0 or nominal in found
                    or value <= 0 or abs(value - nominal) >= nominal / 2):
                return {}, {'reason': f'page {page}: invalid, duplicate or outside half the nominal average'}
            found[nominal] = value
        positions.extend({**p, 'page': page, 'reader': reader} for p in source_positions)
    return found, {'positions': positions} if found else {'reason': '; '.join(reasons)}


def text_average_inventory(source):
    """Enumerate ALL formerly 'none' documents, including rejection reasons."""
    cert_docs = os.path.join(source, 'Cert Docs')
    inventory = {}
    for body in ('NAR', 'TRA'):
        root = os.path.join(cert_docs, body)
        for folder, _dirs, names in sorted(os.walk(root)):
            for name in sorted(names):
                if not name.lower().endswith('.pdf'):
                    continue
                path = os.path.join(folder, name)
                rel = f'{body}/' + os.path.relpath(path, root).replace(os.sep, '/')
                form, _delays, _facts = read_document(path, rel)
                if form == 'none':
                    averages, facts = text_averages(path)
                    inventory[rel] = {'averages': averages, **facts}
    return inventory


def inventory_summary(inventory, eligible_only=False):
    """Counts and documents; the shipped data keeps only the documents read
    (--text-average-inventory prints every rejection reason too)."""
    eligible = {rel: item for rel, item in inventory.items() if item['averages']}
    return {
        'documentsRead': len(eligible),
        'nominalsRead': sum(len(item['averages']) for item in eligible.values()),
        'byReader': {body: {
            'documents': sum(any(p['reader'] == body.lower() for p in item['positions'])
                             for item in eligible.values()),
            'nominals': sum(len({p['nominalS'] for p in item['positions'] if p['reader'] == body.lower()})
                            for item in eligible.values()),
        } for body in ('NAR', 'TRA')},
        'documents': eligible if eligible_only else inventory,
    }


def nar_repeats(rows):
    """{nominal: [numbers]} from the summary that prints each motor's delay again, under an "Actual" heading.

    Its rows come in three orders ("4 | 2.5 to 5.5 | 4.57 | ... | 4.69", "2.5
    to 5.5 | 4 | ...", "3 | TO | 5 | 4 | 4.33 | 4.28 | ..."). With the allowed
    range ("a to b") taken out, the first number is the nominal in all three,
    and the rest are each motor's delay and, in most, their average.
    """
    out = {}
    for i, row in enumerate(rows):
        if not any(w[2].lower() == 'actual' for w in row):
            continue
        for r in rows[i + 1:i + 8]:
            toks = [w[2] for w in r]
            if num(toks[0]) is None:
                break
            kept, k = [], 0
            while k < len(toks):
                if k + 2 < len(toks) and toks[k + 1].lower() == 'to' and num(toks[k]) is not None and num(toks[k + 2]) is not None:
                    k += 3
                    continue
                kept.append(toks[k])
                k += 1
            numbers = [num(t) for t in kept]
            if len(numbers) < 2 or any(n is None for n in numbers) or not numbers[0].is_integer():
                break
            out[int(numbers[0])] = numbers[1:]
    return out


def same_print(values, printed):
    """Do `values` appear in `printed`, each matched to its own number, with at most one left over (the average)?"""
    left = list(printed)
    for v in values:
        hit = next((j for j, p in enumerate(left) if abs(p - v) <= PRINT_TOLERANCE_S), None)
        if hit is None:
            return False
        left.pop(hit)
    return len(left) <= 1


def checked_against_itself(by_nominal, rows, where):
    """The motor table's delays, less any DISPUTED nominal, after checking them against the document's other prints.

    Returns (delays, the number of nominals a second print confirmed).
    """
    averages, repeats = nar_averages(rows), nar_repeats(rows)
    bad_average, bad_repeat = set(), set()
    for nominal, values in by_nominal.items():
        if nominal in averages and abs(sum(values) / len(values) - averages[nominal]) > PRINT_TOLERANCE_S:
            bad_average.add(nominal)
        if nominal in repeats and not same_print(values, repeats[nominal]):
            bad_repeat.add(nominal)
    for name, found, listed in (('AVERAGE_DISAGREES', bad_average, AVERAGE_DISAGREES.get(where, set())),
                                ('DISPUTED', bad_repeat, DISPUTED.get(where, set()))):
        if found != listed:
            detail = '; '.join(
                f'{n} s reads {by_nominal[n]}, averaged {averages.get(n)}, summarised {repeats.get(n)}'
                for n in sorted(found ^ listed) if n in by_nominal)
            raise SystemExit(f'{where}: {name} lists {sorted(listed)}, the document gives {sorted(found)}: {detail}')
    kept = {n: v for n, v in by_nominal.items() if n not in bad_repeat}
    confirmed = sum(1 for n in kept if (n in averages and n not in bad_average) or n in repeats)
    return kept, confirmed


# ------------------------------------------------------------------ documents

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
            safe = re.sub(r'[\\/:*?"<>|]', '-', name) + '.pdf'
            urls[f'{case.replace(chr(92), "/")}/{safe}'] = quote(url, safe=':/%')
    return urls


def read_document(path, where):
    """('tmt' | 'nar', {nominal: [measured]}, facts) for a document that prints each motor's delay; None otherwise."""
    with pymupdf.open(path) as doc:
        rows = word_rows(doc)
    if not rows:
        return 'scan', None, {}
    tmt = tmt_delays(rows, where)
    if tmt:
        tested = tmt_motors_tested(rows)
        fired = sum(len(v) for v in tmt.values())
        if tested is None or fired > tested:
            raise SystemExit(f'{where}: {fired} delays read, {tested} motors tested')
        return 'tmt', tmt, {'motorsTested': tested}
    tables = nar_tables(rows, where)
    if len(tables) > 1:
        raise SystemExit(f'{where}: {len(tables)} per-motor tables')
    if not tables:
        return 'none', None, {}
    by_nominal, no_data, plugged = {}, 0, 0
    for nominal, measured in tables[0]:
        if nominal == 'P':
            plugged += 1
        elif measured is None:
            no_data += 1
        else:
            by_nominal.setdefault(nominal, []).append(measured)
    if not by_nominal:
        return 'plugged' if plugged else 'none', None, {}
    kept, confirmed = checked_against_itself(by_nominal, rows, where)
    return 'nar', kept, {'noData': no_data, 'confirmed': confirmed, 'nominals': len(kept)}


def source_hash(path):
    with open(path, 'rb') as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def checked_transcriptions(cert_docs, path):
    """Separate cross-checked individual measurements from independently read averages."""
    with open(path, encoding='utf-8') as fh:
        data = json.load(fh)
    accepted, averages, seen = {}, {}, set()
    for entry in data['documents'] + data['unread']:
        rel = entry['document']
        if rel in seen or not re.match(r'^(NAR|TRA)/', rel) or '..' in rel.split('/'):
            raise SystemExit(f'{rel}: duplicate or invalid transcription document')
        seen.add(rel)
        pdf_path = os.path.join(cert_docs, rel)
        if source_hash(pdf_path) != entry.get('sha256'):
            raise SystemExit(f'{rel}: source hash changed; re-render and review the scan')
        with pymupdf.open(pdf_path) as doc:
            if any(page.get_text('words') for page in doc):
                raise SystemExit(f'{rel}: transcription source is not a scan')
            pages = len(doc)
        def position(item):
            p = item.get('position') or {}
            if (type(p.get('page')) is not int or not 1 <= p['page'] <= pages
                    or not p.get('row') or not p.get('column')):
                raise SystemExit(f'{rel}: missing or invalid source position')

        def numbers(printed):
            if not printed or any(not isinstance(v, str) or num(v) is None or num(v) <= 0 for v in printed):
                raise SystemExit(f'{rel}: expected positive printed seconds')
            return [float(v) for v in printed]

        if entry in data['unread']:
            if not entry.get('reason'):
                raise SystemExit(f'{rel}: unread scan needs a reason')
            printed = {}
            for item in entry.get('printedAverages', []):
                nominal = item['nominalS']
                if type(nominal) is not int or nominal <= 0 or nominal in printed:
                    raise SystemExit(f'{rel}: invalid or duplicate average nominal')
                position(item)
                p = item['position']
                if (type(p['column']) is not int or p['column'] < 1
                        or p['row'] != 'Avg. Measured Delay'):
                    raise SystemExit(f'{rel}: invalid average source position')
                value = numbers([item.get('printed')])[0]
                if abs(value - nominal) >= nominal / 2:
                    raise SystemExit(f'{rel}: average outside half the nominal')
                if item.get('label') != 'Avg. Measured Delay':
                    raise SystemExit(f'{rel}: unexpected average label')
                printed[nominal] = value
            if entry.get('category') == 'average-only' and not printed:
                raise SystemExit(f'{rel}: average-only scan needs printed averages')
            if printed:
                averages[rel] = printed
            continue

        delays = {}
        for delay in entry['delays']:
            nominal = delay['nominalS']
            if type(nominal) is not int or nominal <= 0 or nominal in delays:
                raise SystemExit(f'{rel}: invalid or duplicate nominal')
            if nominal in DISPUTED.get(rel, set()):
                raise SystemExit(f'{rel}: {nominal} s is withheld as disputed')
            measurements = delay['measurements']
            for item in measurements:
                position(item)
            values = numbers([item['printed'] for item in measurements])
            checks = delay.get('crossChecks') or []
            if not checks:
                raise SystemExit(f'{rel}: {nominal} s missing cross-check')
            for check in checks:
                position(check)
                printed = numbers(check['printed'])
                if check['kind'] == 'average':
                    if len(printed) != 1 or abs(sum(values) / len(values) - printed[0]) > PRINT_TOLERANCE_S:
                        raise SystemExit(f'{rel}: {nominal} s average disagrees')
                elif check['kind'] == 'summary':
                    if len(printed) != len(values) or not same_print(values, printed):
                        raise SystemExit(f'{rel}: {nominal} s summary disagrees')
                else:
                    raise SystemExit(f'{rel}: unknown cross-check kind {check["kind"]!r}')
            delays[nominal] = values
        if not delays:
            raise SystemExit(f'{rel}: reviewed scan has no delays')
        accepted[rel] = (entry, delays)
    return accepted, data['unread'], averages


def read_all(source, motors_path, join=None, transcriptions=DEFAULT_TRANSCRIPTIONS,
             average_join=None, average_disputed=None):
    join = dict(JOIN if join is None else join)
    cert_docs = os.path.join(source, 'Cert Docs')
    reviewed, unread, printed_averages = checked_transcriptions(cert_docs, transcriptions)
    scan_averages_read = len(printed_averages)
    average_forms = {rel: 'scan-average' for rel in printed_averages}
    text_inventory = {}
    unread_paths = {entry['document'] for entry in unread}
    for rel, (entry, _delays) in reviewed.items():
        target = (entry['manufacturer'], entry['designation'])
        if rel in join and tuple(join[rel]) != target:
            raise SystemExit(f'{rel}: transcription conflicts with JOIN')
        join[rel] = target
    urls = download_urls(cert_docs)
    with open(motors_path, encoding='utf-8') as fh:
        catalogue = json.load(fh)
    by_name = {}
    for m in catalogue['motors']:
        by_name.setdefault((m['manufacturerAbbrev'], m['designation']), []).append(m)
    forms = {'tmt': 0, 'nar': 0, 'plugged': 0, 'none': 0, 'scan': 0, 'scan-reviewed': 0, 'text-average': 0}
    motors, unjoined, seen = {}, [], set()
    for body in ('NAR', 'TRA'):
        root = os.path.join(cert_docs, body)
        for folder, _dirs, names in sorted(os.walk(root)):
            for name in sorted(names):
                if not name.lower().endswith('.pdf'):
                    continue
                rel = f'{body}/' + os.path.relpath(os.path.join(folder, name), root).replace(os.sep, '/')
                form, delays, facts = read_document(os.path.join(folder, name), rel)
                if rel in reviewed:
                    form, delays = 'scan-reviewed', reviewed[rel][1]
                if form == 'scan' and rel not in unread_paths:
                    raise SystemExit(f'{rel}: scan has no unread review entry')
                if form == 'none':
                    averages, average_facts = text_averages(os.path.join(folder, name))
                    text_inventory[rel] = {'averages': averages, **average_facts}
                    if averages:
                        printed_averages[rel] = averages
                        average_forms[rel] = 'text-average'
                        form = 'text-average'
                forms[form] += 1
                if delays is None:
                    continue
                if rel not in join:
                    raise SystemExit(f'{rel}: measured delays and no JOIN entry')
                seen.add(rel)
                if join[rel] is None:
                    unjoined.append(rel)
                    continue
                rows = by_name.get(tuple(join[rel]), [])
                if len(rows) != 1:
                    raise SystemExit(f'{rel}: JOIN {join[rel]} matches {len(rows)} catalogue rows')
                motor = rows[0]
                if rel not in urls:
                    raise SystemExit(f'{rel}: not in Download-CertDocs.ps1, so its URL is unknown')
                if motor['motorId'] in motors:
                    raise SystemExit(f'{rel}: {motor["designation"]} already read from {motors[motor["motorId"]]["document"]}')
                motors[motor['motorId']] = {
                    'designation': motor['designation'],
                    'manufacturer': motor['manufacturerAbbrev'],
                    'document': rel,
                    'url': urls[rel],
                    'form': form,
                    'delays': [
                        {'nominalS': n, 'measuredS': [as_number(v) for v in delays[n]]}
                        for n in sorted(delays)
                    ],
                }
    stale = sorted(set(join) - seen)
    if stale:
        raise SystemExit(f'JOIN names documents with no measured delays read: {stale}')
    averages = join_averages(printed_averages, by_name, motors, urls,
                            AVERAGE_JOIN if average_join is None else average_join,
                            AVERAGE_DISPUTED if average_disputed is None else average_disputed,
                            average_forms)
    pairs = sum(len(m['delays']) for m in motors.values())
    return {
        'source': 'AeroTech (RCS Rocket Motor Components) NAR and TRA certification documents: individual measured delays and separately labelled printed averages',
        'publishedOn': PUBLISHED_ON,
        'folder': 'docs/RCS Schematics/Cert Docs (local-only)',
        'extractedBy': 'packages/app/scripts/extract-aerotech-delays.py',
        'documents': forms,
        'scanReview': {
            'reviewed': len(reviewed) + len(unread),
            'accepted': len(reviewed),
            'unreadForMerge': len(unread),
            'averagesRead': scan_averages_read,
            'source': 'packages/app/scripts/aerotech-delay-transcriptions.json',
        },
        'textAverageReview': inventory_summary(text_inventory, eligible_only=True),
        'notInCatalogue': unjoined,
        'motorCount': len(motors),
        'pairCount': pairs,
        'motors': dict(sorted(motors.items(), key=lambda kv: (kv[1]['manufacturer'], kv[1]['designation']))),
        'averageMotorCount': len(averages),
        'averagePairCount': sum(len(m['delays']) for m in averages.values()),
        'averages': averages,
    }


def check_hardware(rel, motor):
    """A source folder must describe the catalogue motor's hardware class."""
    folder = rel.rsplit('/', 1)[0]
    hardware = ('SU' if re.search(r'Single[- ]Use', folder, re.I) else
                'reload' if re.search(r'RMS-|reload', folder, re.I) else None)
    if hardware is None or hardware != motor.get('type'):
        raise SystemExit(f'{rel}: HARDWARE_MISMATCH: folder class {hardware!r}, '
                         f'catalogue {motor["designation"]} type {motor.get("type")!r}')


def join_averages(printed, by_name, measured, urls, joins, disputed, forms=None):
    """Join averages separately; every duplicate source must agree at a nominal."""
    grouped = {}
    forms = forms or {}
    for rel, delays in printed.items():
        if rel not in joins:
            raise SystemExit(f'{rel}: printed averages and no AVERAGE_JOIN entry')
        if joins[rel] is None:
            continue
        target = tuple(joins[rel])
        rows = by_name.get(target, [])
        if len(rows) != 1:
            raise SystemExit(f'{rel}: AVERAGE_JOIN {target} matches {len(rows)} catalogue rows')
        motor = rows[0]
        check_hardware(rel, motor)
        if motor['motorId'] in measured:
            raise SystemExit(f'{rel}: average joins a measured motor; measured data wins')
        if rel not in urls:
            raise SystemExit(f'{rel}: average source URL is unknown')
        grouped.setdefault(target, []).append((rel, delays, motor))
    stale = set(joins) - set(printed)
    if stale:
        raise SystemExit(f'AVERAGE_JOIN names documents with no averages: {sorted(stale)}')
    out, found_disputes = {}, {}
    for target, sources in sorted(grouped.items()):
        sources.sort(key=lambda source: source[0])
        nominals = set().union(*(set(d) for _, d, _ in sources))
        bad, delays = set(), []
        for n in sorted(nominals):
            values = [d[n] for _, d, _ in sources if n in d]
            if len(values) != len(sources) or max(values) - min(values) > PRINT_TOLERANCE_S:
                bad.add(n)
            else:
                delays.append({'nominalS': n, 'averageS': as_number(values[0])})
        if bad:
            found_disputes[target] = bad
        if delays:
            rel, _, motor = sources[0]
            out[motor['motorId']] = {
                'designation': motor['designation'], 'manufacturer': motor['manufacturerAbbrev'],
                'documents': sorted(r for r, _, _ in sources), 'url': urls[rel],
                'form': forms.get(rel, 'scan-average'), 'delays': delays,
                'documentForms': {r: forms.get(r, 'scan-average') for r, _, _ in sources},
            }
    if found_disputes != disputed:
        raise SystemExit(f'AVERAGE_DISPUTED lists {disputed}, documents give {found_disputes}')
    return out


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--source', default=os.environ.get('RCS_SCHEMATICS') or
                    reference_dir('RCS Schematics', os.path.join(HERE, '..', '..', '..')))
    ap.add_argument('--motors', default=DEFAULT_MOTORS)
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--transcriptions', default=DEFAULT_TRANSCRIPTIONS)
    ap.add_argument('--watch-out', help='also generate/check the published-source watch snapshot')
    # extract-aerotech-delays.test.mjs's synthetic documents are not the real ones.
    ap.add_argument('--join', help='a JSON file replacing JOIN: {document: [manufacturer, designation] or null}')
    ap.add_argument('--average-join', help='a JSON file replacing AVERAGE_JOIN, with the same format as --join')
    ap.add_argument('--text-average-inventory', action='store_true',
                    help='print every formerly none document and coordinate-read counts; no writes or joins')
    args = ap.parse_args(argv)
    join = None
    if args.join:
        with open(args.join, encoding='utf-8') as fh:
            join = json.load(fh)
    average_join = None
    if args.average_join:
        with open(args.average_join, encoding='utf-8') as fh:
            average_join = json.load(fh)
    if not args.source:
        ap.error('No RCS document set found; pass --source or set RCS_SCHEMATICS or MMRSIM_REFERENCE_ROOT')
    if args.text_average_inventory:
        print(json.dumps(inventory_summary(text_average_inventory(args.source)), ensure_ascii=False, indent=2))
        return 0
    data = read_all(args.source, args.motors, join, args.transcriptions, average_join)
    outputs = {args.out: json.dumps(data, ensure_ascii=False, indent=2) + '\n'}
    if args.watch_out:
        cert_docs = os.path.join(args.source, 'Cert Docs')
        urls = download_urls(cert_docs)
        with open(args.transcriptions, encoding='utf-8') as fh:
            review = json.load(fh)
        # Watch all index links, plus the bytes we consume or may consume after
        # Eric rules on the four count-only scans. Do not fetch 314 PDFs per run.
        paths = {m['document'] for m in data['motors'].values()}
        paths.update(rel for m in data['averages'].values() for rel in m['documents'])
        paths.update(rel for rel, item in data['textAverageReview']['documents'].items() if item['averages'])
        paths.update(e['document'] for e in review['unread'] if e.get('candidateDelays'))
        snapshot = {
            'publishedOn': PUBLISHED_ON,
            'indexPdfUrls': sorted(set(urls.values())),
            'documents': [{'document': rel, 'url': urls[rel], 'sha256': source_hash(os.path.join(cert_docs, rel))}
                          for rel in sorted(paths)],
        }
        outputs[args.watch_out] = json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n'
    if args.check:
        same = True
        for path, text in outputs.items():
            with open(path, encoding='utf-8') as fh:
                matches = fh.read() == text
            same = same and matches
            print(f'{os.path.basename(path)} is what the documents give' if matches else
                  f'{os.path.basename(path)} DIFFERS from what the documents give: re-run without --check')
        print(f'averageMotorCount={data["averageMotorCount"]} averagePairCount={data["averagePairCount"]}')
        return 0 if same else 1
    for path, text in outputs.items():
        atomic_write(path, text)
        print(f'wrote {path}')
    print(f'averageMotorCount={data["averageMotorCount"]} averagePairCount={data["averagePairCount"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
