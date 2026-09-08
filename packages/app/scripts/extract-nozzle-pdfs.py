"""
Raw text/structure extraction from the AeroTech/RCS document set, for
build-nozzle-db.mjs. Reads only; writes a single JSON document to stdout.

WHY PYTHON, in a repo whose pipeline is otherwise Node (2026-09-08): the source
is 324 vector PDFs whose LIST OF MATERIAL tables have to be read POSITIONALLY,
and the repo has no PDF library at all — `ls node_modules | grep pdf` is empty,
and the house rule is no new app dependencies. PyMuPDF is already installed on
this machine (1.28.0), so the extractor is Python and everything that INTERPRETS
what it finds — the dash-number rule, the Medusa area sums, the join to
motors.json — stays in the .mjs beside the other pipeline scripts.

WHAT IS AND IS NOT DONE HERE. This file extracts FACTS: which words sit in which
table cell, what a store page's summary paragraph says, which numbers a drawing
prints. It makes no judgement about what any of them mean. That split is
deliberate: a judgement call in a language nobody else in this repo reads is a
judgement call nobody will review.

THE ONE HARD PART — reading a drawing's LIST OF MATERIAL. `page.get_text()`
returns the table's words in PDF content order, which jumbles the cells: the
N4000W-PS nozzle row comes back as the description and the part number on two
different lines, and a naive line-adjacency parse resolved a nozzle part in only
27 of the 324 drawings. Two things fix it, and both are needed:

  1. ROTATION. 181 of the 324 drawings are drawn sideways — every line has a
     text direction of (0,-1), so what looks like a "row" of constant y is
     really a COLUMN. `dominant_dir`/`xform` rotate every word's box into
     reading orientation first. Without this the header is never found at all.
  2. Y-CLUSTERING WITH A TOLERANCE. Cells in one row are not at identical y
     (the N4000W-PS part number sits 1.1 pt below its own description), so
     words are clustered into rows within 3 pt rather than bucketed on an exact
     key, and the x-band is clipped to the LIST OF MATERIAL columns using the
     x of the "QTY" header word — otherwise the notes down the left of the
     sheet merge into the table rows.

With both, all 324 drawings yield a header and a nozzle row.

Usage: python extract-nozzle-pdfs.py "<RCS Schematics folder>"
"""
import email
import glob
import html
import json
import os
import re
import sys

import fitz  # PyMuPDF


# ----------------------------------------------------------------- PDF tables

def dominant_dir(page):
    """The writing direction most of this page's characters use, rounded."""
    counts = {}
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            key = tuple(round(v) for v in line["dir"])
            counts[key] = counts.get(key, 0) + sum(len(s["text"]) for s in line.get("spans", []))
    return max(counts.items(), key=lambda kv: kv[1])[0] if counts else (1, 0)


def xform(direction):
    """Rotation that carries `direction` to (1,0), i.e. to normal reading order."""
    if direction == (0, -1):
        return lambda x, y: (-y, x)
    if direction == (0, 1):
        return lambda x, y: (y, -x)
    if direction == (-1, 0):
        return lambda x, y: (-x, -y)
    return lambda x, y: (x, y)


def norm_words(page):
    """Every word as (x0, y0, x1, y1, text) in reading orientation."""
    f = xform(dominant_dir(page))
    out = []
    for word in page.get_text("words"):
        x0, y0, x1, y1, text = word[:5]
        a = f(x0, y0)
        b = f(x1, y1)
        out.append((min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]), text))
    return out


# A LIST OF MATERIAL row, once its cells are back in order:
#   QTY | PART NUMBER | DESCRIPTION ... | ITEM
# The part number allows "()" because the 98 mm modified-mould parts are
# written 01800-4(M); it allows "/" and "." because 03040-9, 98FSDSS and
# ISP28-601901 all appear in the same column.
LOM_ROW = re.compile(r'^(\d+)\s+([A-Z0-9][A-Z0-9\-./()]*)\s+(.+?)\s+(\d+)$')


def lom_rows(page, ytol=3.0):
    """Reconstructed LIST OF MATERIAL text rows, or None if this page has no LOM."""
    words = norm_words(page)
    if not words:
        return None
    qty_x = None
    by_y = {}
    for w in words:
        by_y.setdefault(round(w[1] / 3.0), []).append(w)
    for group in by_y.values():
        texts = {w[4].upper() for w in group}
        if 'QTY' in texts and 'DESCRIPTION' in texts and ('NUMBER' in texts or 'PART' in texts):
            qty_x = min(w[0] for w in group if w[4].upper() == 'QTY')
            break
    if qty_x is None:
        return None
    # Clip to the table's own columns; the left of the sheet is notes and views.
    band = sorted([w for w in words if w[0] >= qty_x - 10], key=lambda w: w[1])
    rows, cur, cur_y = [], [], None
    for w in band:
        centre = (w[1] + w[3]) / 2
        if cur_y is None or abs(centre - cur_y) <= ytol:
            cur.append(w)
            cur_y = centre if cur_y is None else (cur_y * (len(cur) - 1) + centre) / len(cur)
        else:
            rows.append(cur)
            cur, cur_y = [w], centre
    if cur:
        rows.append(cur)
    return [" ".join(w[4] for w in sorted(r, key=lambda w: w[0])) for r in rows]


def page_text(doc):
    """All of a document's text, whitespace collapsed."""
    return re.sub(r'\s+', ' ', " ".join(p.get_text() for p in doc)).strip()


# ------------------------------------------------------------- store pages

def mhtml_text(path):
    """The visible text of a saved .mhtml page (quoted-printable is decoded by email)."""
    msg = email.message_from_bytes(open(path, 'rb').read())
    body = None
    for part in msg.walk():
        if part.get_content_type() == 'text/html':
            body = part.get_payload(decode=True).decode('utf-8', 'replace')
            break
    if body is None:
        return ''
    text = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>', ' ', body)
    text = re.sub(r'(?s)<[^>]+>', ' ', text)
    return re.sub(r'\s+', ' ', html.unescape(text)).strip()


# The product's OWN summary, cut off before "Related Products" — the related
# block quotes six other parts' dimensions and would poison every match.
SUMMARY = re.compile(r'Summary (.*?) (?:Updating Order Details|Related Products|Customer Reviews)')
PRODUCT_CODE = re.compile(r'Product Code:\s*([A-Za-z0-9][A-Za-z0-9\-]*)')

# A three-decimal (or two-decimal) inch callout on a drawing. Bare, unlabelled:
# the drawings dimension the part with leader lines, so these are only ever used
# to CONFIRM a number a labelled source already gave.
CALLOUT = re.compile(r'(?<![\d.])(\d{0,2}\.\d{2,3})(?![\d])')
# "01550-1 NOZZLE DRILLED .313"" — the dash-number table most nozzle drawings carry.
DASH_ROW = re.compile(r'((?:0\d{4}|ISP\d+)-\w+)\s+NOZZLE\s+DRILLED\s+(\d*\.\d+)')
# AeroTech's own statement of the rule this database rests on.
DASH_RULE = re.compile(r'DASH NUMBERS INDICATE IN-HOUSE MACHINING OF THROAT DIAMETER', re.I)

# A row of the REVISIONS block every RCS drawing carries:
#   "FUTURE C PER EO 'C', NEW HIGH POWER NOZZLE 8 / 19 / 04"
# Added 2026-09-08. It is the only thing on a sheet that dates its own content,
# and without it the build picked between two sheets for one motor by FILENAME
# ("New" beats "Original"), which is blind to a dated engineering order. The
# K1100T is the case: its -L sheet carries the 2004 "NEW HIGH POWER NOZZLE"
# revision and the 01670-3 that goes with it, while -M/-S/-X stop at a 2002
# delay-system revision and still show the Medusa. Majority-of-sheets voted
# 3-1 for the superseded part.
REVISION = re.compile(
    r'FUTURE\s+([A-Z])\b(.{0,80}?)(\d{1,2}\s*/\s*\d{1,2}\s*/\s*\d{2,4})')
# Which revisions are ABOUT the nozzle — the word in the revision's own text.
REV_NOZZLE = re.compile(r'NOZZLE', re.I)


def revisions(text):
    """Every REVISIONS row as {letter, text, date, isoDate, mentionsNozzle}.

    `isoDate` is sortable; a two-digit year is 19xx for 90-99 and 20xx below
    that, which covers 1990-2089 and therefore every sheet in this set (the
    oldest is 1999). Rows whose date will not parse keep isoDate None and sort
    last, so a broken date can never win a pick.
    """
    out = []
    for letter, body, date in REVISION.findall(re.sub(r'\s+', ' ', text)):
        parts = [p.strip() for p in date.split('/')]
        iso = None
        if len(parts) == 3 and all(p.isdigit() for p in parts):
            mm, dd, yy = (int(p) for p in parts)
            year = yy if yy > 99 else (1900 + yy if yy >= 90 else 2000 + yy)
            if 1 <= mm <= 12 and 1 <= dd <= 31:
                iso = '%04d-%02d-%02d' % (year, mm, dd)
        body = body.strip(' ,-')
        out.append({'letter': letter, 'text': body, 'date': date.strip(),
                    'isoDate': iso, 'mentionsNozzle': bool(REV_NOZZLE.search(body))})
    return out


def main(root):
    out = {'root': os.path.abspath(root), 'assemblies': [], 'specPages': [],
           'nozzleDrawings': [], 'certNozzles': []}

    asm_root = os.path.join(root, 'Motor Assembly Drawings')
    for path in sorted(glob.glob(os.path.join(asm_root, '**', '*.pdf'), recursive=True)):
        rel = os.path.relpath(path, asm_root).replace(os.sep, '/')
        doc = fitz.open(path)
        rows, found_header = [], False
        for page in doc:
            page_rows = lom_rows(page)
            if page_rows is None:
                continue
            found_header = True
            for line in page_rows:
                m = LOM_ROW.match(line)
                if not m:
                    continue
                rows.append({'qty': m.group(1), 'part': m.group(2),
                             'desc': m.group(3).strip(), 'item': m.group(4), 'raw': line})
        text = page_text(doc)
        # Does the designation the filename claims actually appear on the sheet?
        # Provenance, not parsing: a filename is a claim until the drawing agrees.
        designation = re.sub(r'\s*\([^)]*\)\s*$', '', os.path.basename(path)[:-4])
        designation = re.sub(r'\s+(?:2-Grain|LMS)\b.*$', '', designation, flags=re.I)
        designation = re.sub(r'\s+Assembly.*$', '', designation, flags=re.I).strip()
        squash = lambda s: re.sub(r'[^A-Z0-9]', '', s.upper())
        # The sheet often prints the motor WITHOUT the delay tag the filename
        # carries ("H165R" for H165R-L) or with a different one (the K1800ST-PS
        # sheet says K1800ST-P, and so does thrustcurve.org), so the stem is
        # reported separately rather than counted as a failure to corroborate.
        stem = re.sub(r'-(?:S|M|L|X|P|PS|\d+A)$', '', designation)
        out['assemblies'].append({
            'file': rel,
            'caseFolder': rel.split('/')[0],
            'designationFromFile': designation,
            'foundLomHeader': found_header,
            'designationOnSheet': squash(designation) in squash(text),
            'designationStemOnSheet': squash(stem) in squash(text),
            'revisions': revisions(text),
            'lomRows': rows,
        })

    noz_root = os.path.join(root, 'Nozzles')
    for path in sorted(glob.glob(os.path.join(noz_root, '*.mhtml'))):
        text = mhtml_text(path)
        code = PRODUCT_CODE.search(text)
        summary = SUMMARY.search(text)
        out['specPages'].append({
            'file': 'Nozzles/' + os.path.basename(path),
            'productCode': code.group(1) if code else None,
            'title': os.path.basename(path)[:-6].replace('_', '"'),
            'summary': summary.group(1).strip() if summary else None,
        })

    # Tripoli's certification letters carry two fields nothing else in the set
    # does: "Nozzle Throat Diameter (in)" and "Nozzle Exit Cone Diameter (in)",
    # measured by the certifying body rather than stated by the maker. Only 12
    # of the 312 letters have them and every one is a 1997-2001 test, so they
    # are a CROSS-CHECK on an independent source, never an input — the builder
    # compares and reports, and the current drawings win.
    out['certNozzles'] = []
    cert_root = os.path.join(root, 'Cert Docs')
    for path in sorted(glob.glob(os.path.join(cert_root, '**', '*.pdf'), recursive=True)):
        text = page_text(fitz.open(path))
        throat = re.search(r'Nozzle Throat Diameter \(in\):\s*([\d.]+)', text)
        exit_d = re.search(r'Nozzle Exit Cone Diameter \(in\):\s*([\d.]+)', text)
        if not (throat and exit_d):
            continue
        tested = re.search(r'Test Date:\s*([\d/]+)', text)
        until = re.search(r'Certified Until:\s*([\d/]+)', text)
        out['certNozzles'].append({
            'file': os.path.relpath(path, root).replace(os.sep, '/'),
            'designation': os.path.basename(path)[:-4],
            'throatIn': float(throat.group(1)),
            'exitIn': float(exit_d.group(1)),
            'testDate': tested.group(1) if tested else None,
            'certifiedUntil': until.group(1) if until else None,
        })

    for path in sorted(glob.glob(os.path.join(noz_root, '*.pdf'))):
        text = page_text(fitz.open(path))
        out['nozzleDrawings'].append({
            'file': 'Nozzles/' + os.path.basename(path),
            'callouts': sorted({float(v) for v in CALLOUT.findall(text)}),
            'dashRows': [[a, b] for a, b in DASH_ROW.findall(text)],
            'statesDashNumberRule': bool(DASH_RULE.search(text)),
            'revisions': revisions(text),
            'text': text,
        })

    json.dump(out, sys.stdout, indent=1)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit('usage: extract-nozzle-pdfs.py "<RCS Schematics folder>"')
    main(sys.argv[1])
