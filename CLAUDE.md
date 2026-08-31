# Working on carpark-sg

@AGENTS.md

This file exists only to import the rules above.

Without it nothing in `AGENTS.md` reaches an agent's context automatically, and
on 2026-08-31 that had a cost worth recording: a session opened with its working
directory one level up, so the rules it loaded were the PARENT repo's. Those
rules are plausible — same fleet, same droplet, same conventions — and wrong in
the details that matter. A `.nvmrc` rule was followed here that belongs to that
repo and had no file behind it, and `~/Git/check-comms.sh`, which this file's
line 23 says to run rather than assume, went unrun for a whole session.

Rules that are not loaded are not rules.
