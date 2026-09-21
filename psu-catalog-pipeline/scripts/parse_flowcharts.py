"""Spatially parse the Engineering Advising flowchart PDFs into
{pdf: {semester_index: [course codes]}} using word coordinates (text order in
these PDFs is jumbled; columns are the ground truth).

Method: find the "1st/2nd/... Semester" header words; their x-centers define
column bands. Every course code found on the page is assigned to the nearest
column. Output: data/flowcharts/parsed.json
"""
import fitz  # PyMuPDF
import glob, json, os, re, sys

DIR = os.path.join(os.path.dirname(__file__), "..", "data", "flowcharts")

SEM_RE = re.compile(r"^(\d)(?:st|nd|rd|th)$", re.I)
# Course codes as they appear on flowcharts: "CMPSC 465", "A-I 305", "E SC 419H", "MATH 140"
CODE_RE = re.compile(r"^([A-Z]{1,6}(?:-[A-Z])?)$")
NUM_RE = re.compile(r"^(\d{2,3}[A-Z]{0,2})[*#~]*[,;]?$")

def norm_subj(s):
    return s.replace("-", "").replace(" ", "")

def parse_pdf(path):
    doc = fitz.open(path)
    page = doc[0]
    words = page.get_text("words")  # x0, y0, x1, y1, text, block, line, word
    # 1. semester column centers from "N(st|nd...) Semester" headers, or the
    # "Year N: Fall|Spring" style used by ESC/EMET/SURE.
    cols = {}
    for i, w in enumerate(words):
        m = SEM_RE.match(w[4])
        if m and i + 1 < len(words) and words[i + 1][4].lower().startswith("semester"):
            cols[int(m.group(1))] = (w[0] + words[i + 1][2]) / 2
    if not cols:
        for i, w in enumerate(words):
            if w[4].lower() == "year" and i + 2 < len(words):
                ym = re.match(r"^(\d)[:.]?$", words[i + 1][4])
                term = words[i + 2][4].lower().rstrip(":")
                if ym and term in ("fall", "spring"):
                    sem = (int(ym.group(1)) - 1) * 2 + (1 if term == "fall" else 2)
                    cols[sem] = (w[0] + words[i + 2][2]) / 2
    if not cols:
        return None
    col_ids = sorted(cols)
    # 2. walk words; subject token followed by number token = course
    result = {n: [] for n in col_ids}
    i = 0
    while i < len(words):
        w = words[i]
        subj_raw = w[4].rstrip("*#~,;:")
        joined = None
        # single-token subject
        if CODE_RE.match(subj_raw) and i + 1 < len(words):
            nxt = words[i + 1][4]
            m = NUM_RE.match(nxt)
            if m and abs(words[i + 1][1] - w[1]) < 6:  # same line
                joined = (norm_subj(subj_raw), m.group(1), (w[0] + words[i + 1][2]) / 2)
                i += 2
        # two-token subject: "E SC 419", "CH E 330H"
        if joined is None and i + 2 < len(words) and re.match(r"^[A-Z]{1,3}$", subj_raw):
            s2 = words[i + 1][4].rstrip("*#~,;:")
            if re.match(r"^[A-Z]{1,4}$", s2):
                m = NUM_RE.match(words[i + 2][4])
                if m and abs(words[i + 2][1] - w[1]) < 6:
                    joined = (norm_subj(subj_raw + s2), m.group(1), (w[0] + words[i + 2][2]) / 2)
                    i += 3
        if joined is None:
            i += 1
            continue
        subj, num, xc = joined
        if subj in ("GEN", "ED", "GHW", "FYS", "ETM", "GPA", "AP"):
            continue
        code = f"{subj} {num}"
        sem = min(col_ids, key=lambda n: abs(cols[n] - xc))
        if code not in result[sem]:
            result[sem].append(code)
    return result

out = {}
for path in sorted(glob.glob(os.path.join(DIR, "*.pdf"))):
    name = os.path.basename(path)[:-4]
    try:
        r = parse_pdf(path)
        if r:
            out[name] = {str(k): v for k, v in r.items()}
            total = sum(len(v) for v in r.values())
            print(f"{name}: {len(r)} columns, {total} courses")
        else:
            print(f"{name}: NO semester headers found", file=sys.stderr)
    except Exception as e:
        print(f"{name}: FAILED {e}", file=sys.stderr)

with open(os.path.join(DIR, "parsed.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, indent=1)
print(f"\nwrote parsed.json with {len(out)} flowcharts")
