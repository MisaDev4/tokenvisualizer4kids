---
description: Review the idea list — triage proposals, approve/decline, see what's queued
---

Read `IDEAS.md` at the repo root and help the user triage it. Arguments (optional): $ARGUMENTS

## If there are no arguments

Show a compact review of the current state:
1. **Inbox** — their raw ideas awaiting your assessment. For each, give a one-line take:
   what it would take (size), what it would touch, and whether you think it's worth it. Be
   honest, including "this conflicts with X" or "this is already covered by Y".
2. **Proposed** — your standing suggestions, most compelling first, each with the one-line
   case for it. If some have gone stale (already shipped, or overtaken by later work), say
   so and offer to retire them.
3. **Approved** — what's queued, so they can see the runway.
4. Then give **your recommendation**: the two or three you'd pick next and why, considering
   what already shipped and what the app is currently weakest at. Give a real opinion, not
   a survey.

Keep the whole thing skimmable — this is a decision aid, not a report.

## If there are arguments

Treat them as decisions and apply them to the file, e.g.
`approve T-3, T-7` · `decline T-5, too fiddly` · `T-1 next, then T-2` · `move T-D1 back to proposed`.

- Move rows between sections, preserving ids. A decline **must** carry a reason in the row —
  that reason is what stops future agent waves re-pitching it.
- Reorder **Approved** to reflect any priority the user expressed.
- Never delete an idea outright; declining is how ideas leave.
- Then confirm what changed in a few lines, and state what's now at the top of Approved.

Do not start building anything unless the user explicitly asks in the same message. Approving
an idea queues it; it does not authorize the work to start.
