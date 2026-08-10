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
    # Operator names ("Wilson Parking", "LHN Parking") recur across blocks and
    # can sit BEFORE or AFTER the car park name, so position can't identify
    # them — frequency can. First pass: count the free-floating tokens.
    floating = {}
    for tok in runs:
        if tok in MARKERS or tok in DAY_HEADERS or BAND.match(tok) \
           or SEASON.match(tok) or FULLDAY.match(tok):
            continue
        floating[tok] = floating.get(tok, 0) + 1
    operators = {t for t, n in floating.items() if n >= 3}

    carparks = []
    i = 0
    pending = []           # candidate name tokens seen since the last block
    while i < len(runs):
        tok = runs[i]
        if tok == "Car" and pending:
            names = [t for t in pending if t not in operators]
            ops = [t for t in pending if t in operators]
            name = names[-1] if names else pending[-1]
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
        if tok in MARKERS or BAND.match(tok) or SEASON.match(tok) or FULLDAY.match(tok):
            i += 1
            continue
        pending.append(tok)
        i += 1
    return carparks

def main():
    pdf, out = sys.argv[1], sys.argv[2]
    data = open(pdf, "rb").read()
    runs = runs_from(data)
    cps = parse(runs)
    json.dump(cps, open(out, "w"), indent=1)
    print(f"text runs: {len(runs)}, car parks extracted: {len(cps)}")
    missing = [c["name"] for c in cps if not c["weekday"]]
    print(f"  without a weekday rate: {len(missing)} {missing[:4]}")
    for c in cps[:4]:
        print(f"\n  {c['name']}  (operator: {c['operator']})")
        print(f"    wk : {c['weekday']}")
        print(f"    sun: {c['sundayPh']}")

if __name__ == "__main__":
    main()
