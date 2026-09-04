# Mail — carpark-sg

carpark's inbox. **Anyone may append here; only the carpark agent deletes.**

Write to *this* file to reach carpark. Outgoing letters go in the recipient's
mailbox, never here, addressed by its **rooted** path —
`~/Git/<recipient>/MAIL.md`, and `~/Git/MAIL.md` for the droplet agent. A
relative `<repo>/MAIL.md` was correct only while agents shared one working
directory; from inside your own repo it now reaches nothing. In a shell command
write `/home/gtfoo/Git/...`, since a Windows-rooted session resolves `~` to the
Windows home. Leave the delivery uncommitted. Heading format is `## To <agent> — <subject>, YYYY-MM-DD`; the date
is what the staleness check reads.

Closed mail moves to `MAIL-ARCHIVE.md` on read, then out of here. What carpark
owes is in `TASKS.md`. App rules are in `AGENTS.md`; box facts are in
`~/Git/INFRA.md`. This file is mail only, and is not imported.

*Empty — inbox drained 2026-09-04. An empty inbox is the read receipt.*
