"""
Extracts car park rates from JTC's published carpark-details PDF into JSON the
importer can file: {name, operator, weekday, sundayPh, raw} per car park.

  python3 scripts/jtcRates.py <pdf> <out.json>

The PDF is one block per car park: the name, then Car / Motorcycle / Heavy
Vehicle sections, each with "Monday to Saturday" and "Sunday & Public Holidays"
bands like "0700 to 2230 - 60cents/30mins (capped at $4.80/day)". Only the Car
section is taken. Band text is normalised just enough for the fee engine:
cents to dollars, 24h clocks to am/pm. "Reserved Parking only" is kept
verbatim — it should read as text on the card, never as a price.
"""
import json, re, sys, zlib

MARKERS = {"Car", "Motorcycle", "Heavy Vehicle", "Monday to Saturday",
           "Sunday & Public Holidays"}
BAND = re.compile(r"^(\d{4}) to (\d{4})\s*-\s*(.+)$")
SEASON = re.compile(r"^(Car|Motorcycle|Heavy Vehicle)[^:]*:\s*\$")
# Which columns a day header feeds. "Monday to Sunday" feeds both — those car
# parks charge every day alike, and missing the variant left 36 blank.
DAY_HEADERS = {
    "Monday to Saturday": ("weekday",),
    "Monday to Friday": ("weekday",),
    "Saturday": ("saturday",),
    "Saturday, Sunday & PH": ("saturday", "sundayPh"),
    "Sunday & Public Holidays": ("sundayPh",),
    "Saturday to Sunday/Public Holidays": ("saturday", "sundayPh"),
    "Monday to Sunday/Public Holidays": ("weekday", "saturday", "sundayPh"),
    "Monday to Sunday/Public Holiday": ("weekday", "saturday", "sundayPh"),
    # MUH (Mediapolis) bills Friday with the weekend — the fridayRate column
    # exists for exactly this.
    "Friday to Sunday": ("friday", "saturday", "sundayPh"),
    # Punggol Digital District lists a (Normal) schedule and a (Promotional)
    # one. The promotional prices are what a driver is actually charged today,
    # so those fill the columns and the Normal block is skipped.
    "Monday to Sunday/Public Holidays (Normal)": (),
    "Monday to Friday (Promotional)": ("weekday",),
    "Saturday to Sunday & Public Holidays (Promotional)": ("saturday", "sundayPh"),
    # Lorry-only sites say it outright; leaving keys empty drops their bands
    # and the car park is skipped for having no car rate, which is the truth.
    "Not Applicable": (),
}
# A band that covers the whole day names no clock: "Full day - Free Parking".
FULLDAY = re.compile(r"^Full day\s*-\s*(.+)$", re.I)
# Who runs the car park, when the document names them: "Wilson Parking",
# "LHN Parking", "Metro Parking". Recorded in the notes, never used to decide
# which token is the car park's name.
OPERATOR = re.compile(r"\b(parking|management|carpark)\b", re.I)

def looks_like_name(t):
    """
    Is this token a car park name rather than a stray rate or heading?

    Listing every non-name shape was whack-a-mole — day headers, then season
    lines, then "Containers (excluding Prime Mover)", then bare rate fragments
    — because this PDF's reading order interleaves the Motorcycle and Heavy
    Vehicle sections unpredictably. Testing for what a NAME looks like is
    finite: some letters, no money, no rate vocabulary, not a label.
    """
    if "$" in t or t.rstrip().endswith(":"):
        return False
    if re.search(r"/\d+\s*mins?|per min|per session|capped|cents|full day parking", t, re.I):
        return False
    # Table headings and vehicle-type labels that sit between blocks.
    if re.match(r"^(operator|container|vehicle type|car park name|season|first session)", t, re.I):
        return False
    # No car park is named after a day; these are day headers in a spelling the
    # map doesn't carry ("Sunday/Public Holidays", "Monday to Sunday").
    if re.match(r"^(mon|tue|wed|thu|fri|sat|sun|public holiday|full day)\w*\b", t, re.I):
        return False
    # A lone road-type word is the tail of a wrapped name — "Crescent", left
    # over from "47-79 Ayer Rajah Crescent". Word count alone can't decide
    # this: "Biopolis" is a real car park and rejecting it dropped seventeen
    # blocks, so only the road-type words are refused.
    if re.fullmatch(
        r"(crescent|road|street|avenue|lane|way|drive|link|loop|park|close|"
        r"place|terrace|walk|view|rise|hill|north|south|east|west)\)?",
        t.strip(), re.I,
    ):
        return False
    return bool(re.search(r"[A-Za-z]{3}", t))

def runs_from(pdf_bytes):
    """Full text runs, one per TJ/Tj show operation, in document order."""
    out = []
    for m in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", pdf_bytes, re.S):
        try:
            t = zlib.decompress(m.group(1)).decode("latin1")
        except Exception:
            continue
        if "TJ" not in t and "Tj" not in t:
            continue
        for arr in re.finditer(r"\[(.*?)\]\s*TJ|\((.*?)\)\s*Tj", t, re.S):
            if arr.group(2) is not None:
                s = arr.group(2)
            else:
                # Escaped parens stay INSIDE a segment — a lazy .*? stops at
                # the ")" of "\)" and loses the close of "(capped at $12)".
                s = "".join(re.findall(r"\(((?:\\.|[^()\\])*)\)", arr.group(1)))
            s = s.replace(r"\(", "(").replace(r"\)", ")").replace("\\\\", "\\").strip()
            if s:
                out.append(s)
    return out

def clock(hhmm):
    h, m = int(hhmm[:2]), hhmm[2:]
    ap = "am" if h < 12 else "pm"
    h12 = h % 12 or 12
    return f"{h12}.{m}{ap}"

def norm_rate(text):
    text = re.sub(r"(\d+)\s*cents?", lambda m: f"${int(m.group(1))/100:.2f}", text)
    text = text.replace("/30mins", " per 30 mins").replace("/30 mins", " per 30 mins")
    text = text.replace("/per entry", " per entry")
    text = re.sub(r"\s+", " ", text).strip().rstrip(".")
    if re.fullmatch(r"free parking", text, re.I):
        return "Free"
    return text

def band_line(m):
    return f"{clock(m.group(1))}-{clock(m.group(2))}: {norm_rate(m.group(3))}"

def parse(runs):
    # Position identifies the name: every block is [operator?] [name] "Car",
    # so the token immediately before "Car" is always the car park.
    #
    # An earlier version guessed operators by frequency instead, on the theory
    # that a repeated token must be a company. It isn't — "Toa Payoh Industrial
    # Park" names several car parks and was dropped as an operator, taking 18
    # real entries with it. Operators are recognised by shape now, and only to
    # record who runs the place; they never affect which token is the name.
    carparks = []
    i = 0
    pending = []           # candidate name tokens seen since the last block
    skipped = []
    while i < len(runs):
        tok = runs[i]
        if tok == "Car" and pending:
            # A name wraps across runs when the bracket it opens is still open:
            # "Aviation One, Seletar Aerospace Park (700 West Camp" + "Road)".
            joined = []
            for t in pending:
                if joined and joined[-1].count("(") > joined[-1].count(")"):
                    joined[-1] += " " + t
                else:
                    joined.append(t)
            # The operator sits before the name in some blocks and after it in
            # others, so take the last token that isn't one. Taking simply the
            # last put "Wilson Parking" and "TOP Parking" in the store as car
            # parks fifteen times over.
            names = [t for t in joined if looks_like_name(t) and not OPERATOR.search(t)]
            ops = [t for t in joined if OPERATOR.search(t)]
            if not names:
                skipped.append(joined[-1] if joined else "?")
                pending = []
                i += 1
                continue
            name = names[-1]
            operator = ops[-1] if ops else None
            pending = []
            bands = {"weekday": [], "friday": [], "saturday": [], "sundayPh": []}
            keys = ()
            i += 1
            while i < len(runs) and runs[i] not in ("Motorcycle", "Heavy Vehicle"):
                t = runs[i]
                if t in DAY_HEADERS:
                    keys = DAY_HEADERS[t]
                else:
                    m = BAND.match(t)
                    f = FULLDAY.match(t)
                    if m or f:
                        for k in keys:
                            bands[k].append(band_line(m) if m else norm_rate(f.group(1)))
                    elif re.match(r"^[a-z]", t) and any(bands[k] for k in keys):
                        # A wrapped continuation of the previous band line —
                        # Yew Tee's "capped at $4.00" arrives as its own run.
                        for k in keys:
                            if bands[k]:
                                bands[k][-1] += f" {norm_rate(t)}"
                    elif t not in MARKERS:
                        print(f"  !! unrecognised token in Car section of {name!r}: {t[:60]}")
                i += 1
            carparks.append({
                "name": re.sub(r"\s+", " ", name).strip(),
                "operator": operator,
                "weekday": "; ".join(bands["weekday"]) or None,
                "friday": "; ".join(bands["friday"]) or None,
                "saturday": "; ".join(bands["saturday"]) or None,
                "sundayPh": "; ".join(bands["sundayPh"]) or None,
            })
            continue
        # Day headers and "Not Applicable" appear OUTSIDE Car sections too —
        # under Motorcycle and Heavy Vehicle. Falling through to `pending` let
        # them be taken as car park names, which is how "Not Applicable" and
        # "Monday to Sunday/Public Holidays" reached the store as car parks.
        if (tok in MARKERS or tok in DAY_HEADERS or BAND.match(tok)
                or SEASON.match(tok) or FULLDAY.match(tok)):
            i += 1
            continue
        pending.append(tok)
        i += 1
    if skipped:
        print(f"  !! {len(skipped)} Car section(s) with no name before them:")
        for s in skipped:
            print(f"       {s[:64]}")
    return carparks

def main():
    pdf, out = sys.argv[1], sys.argv[2]
    data = open(pdf, "rb").read()
    runs = runs_from(data)
    cps = parse(runs)
    # Every name must be unique: the importer upserts on a normalised name, so
    # two rows sharing one silently become one, and a junk name shared by three
    # blocks quietly overwrites a real car park.
    seen = {}
    for c in cps:
        k = re.sub(r"[^A-Z0-9]", "", c["name"].upper())
        seen.setdefault(k, []).append(c["name"])
    dupes = {k: v for k, v in seen.items() if len(v) > 1}
    if dupes:
        print(f"  !! {len(dupes)} duplicate name key(s): {list(dupes.values())[:3]}")

    json.dump(cps, open(out, "w"), indent=1)
    print(f"text runs: {len(runs)}, car parks extracted: {len(cps)}, distinct names: {len(seen)}")
    missing = [c["name"] for c in cps if not c["weekday"]]
    print(f"  without a weekday rate: {len(missing)} {missing[:4]}")
    for c in cps[:4]:
        print(f"\n  {c['name']}  (operator: {c['operator']})")
        print(f"    wk : {c['weekday']}")
        print(f"    sun: {c['sundayPh']}")

if __name__ == "__main__":
    main()
