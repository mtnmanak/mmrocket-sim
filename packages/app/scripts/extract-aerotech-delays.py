"""
AeroTech's published MEASURED ejection delays, read into
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
folder's Download-CertDocs.ps1, whose list gives each file's URL. Only the
documents that print EACH motor's delay are read; two forms do:

  - TMT letters (TRA, 2019 on): a "Delay Time Data" row, one line per nominal
    delay, "5 s | 4.946, 4.507, 5.158 s".
  - NAR test reports (2005 to 2017): a table with one row per motor fired, its
    designation carrying the delay it was sold with ("E20-4W", "F51-NT-10",
    "G53-10FJ") and a Delay (or T-DELAY) column holding what it measured.

Documents that print only an AVERAGE per delay (the 1998-2014 NAR summary
sheets without a motor table, and TRA's "Delay Performance (labeled/tested
average)" letters) give no spread and are counted, not read. The 100 scans with
no text layer are out of reach on a machine with no OCR.

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
  python extract-aerotech-delays.py [--source "<RCS Schematics folder>"] [--motors <motors.json>] [--out <file>] [--check] [--join <file>]

--source defaults to $RCS_SCHEMATICS, then to the repo's docs/RCS Schematics.
--motors defaults to src/data/motors.json. --out defaults to
src/data/aerotechDelays.json. --check compares instead of writing, and exits 1
when the committed file is not what the documents give. --join replaces the
JOIN table with a JSON file's (the tests' synthetic documents).
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
DEFAULT_MOTORS = os.path.join(HERE, '..', 'src', 'data', 'motors.json')
DEFAULT_OUT = os.path.join(HERE, '..', 'src', 'data', 'aerotechDelays.json')

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
    doc = pymupdf.open(path)
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


def read_all(source, motors_path, join=None):
    join = JOIN if join is None else join
    cert_docs = os.path.join(source, 'Cert Docs')
    urls = download_urls(cert_docs)
    with open(motors_path, encoding='utf-8') as fh:
        catalogue = json.load(fh)
    by_name = {}
    for m in catalogue['motors']:
        by_name.setdefault((m['manufacturerAbbrev'], m['designation']), []).append(m)
    forms = {'tmt': 0, 'nar': 0, 'plugged': 0, 'none': 0, 'scan': 0}
    motors, unjoined, seen = {}, [], set()
    for body in ('NAR', 'TRA'):
        root = os.path.join(cert_docs, body)
        for folder, _dirs, names in sorted(os.walk(root)):
            for name in sorted(names):
                if not name.lower().endswith('.pdf'):
                    continue
                rel = f'{body}/' + os.path.relpath(os.path.join(folder, name), root).replace(os.sep, '/')
                form, delays, facts = read_document(os.path.join(folder, name), rel)
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
    pairs = sum(len(m['delays']) for m in motors.values())
    return {
        'source': 'AeroTech (RCS Rocket Motor Components) NAR and TRA certification documents: each test motor\'s measured ejection delay',
        'publishedOn': PUBLISHED_ON,
        'folder': 'docs/RCS Schematics/Cert Docs (local-only)',
        'extractedBy': 'packages/app/scripts/extract-aerotech-delays.py',
        'documents': forms,
        'notInCatalogue': unjoined,
        'motorCount': len(motors),
        'pairCount': pairs,
        'motors': dict(sorted(motors.items(), key=lambda kv: (kv[1]['manufacturer'], kv[1]['designation']))),
    }


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--source', default=os.environ.get('RCS_SCHEMATICS', DEFAULT_SOURCE))
    ap.add_argument('--motors', default=DEFAULT_MOTORS)
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--check', action='store_true')
    # extract-aerotech-delays.test.mjs's synthetic documents are not the real ones.
    ap.add_argument('--join', help='a JSON file replacing JOIN: {document: [manufacturer, designation] or null}')
    args = ap.parse_args(argv)
    join = None
    if args.join:
        with open(args.join, encoding='utf-8') as fh:
            join = json.load(fh)
    text = json.dumps(read_all(args.source, args.motors, join), ensure_ascii=False, indent=2) + '\n'
    if args.check:
        with open(args.out, encoding='utf-8') as fh:
            same = fh.read() == text
        print('aerotechDelays.json is what the documents give' if same else
              'aerotechDelays.json DIFFERS from what the documents give: re-run without --check')
        return 0 if same else 1
    with open(args.out, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    print(f'wrote {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
