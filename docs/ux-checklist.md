# UX review checklist (desktop app)

Researched Nov 23 2026 from Apple HIG (https://developer.apple.com/design/human-interface-guidelines/), Microsoft
Windows app design (https://learn.microsoft.com/en-us/windows/apps/design/) and Nielsen Norman Group
(https://www.nngroup.com/articles/). Every review of a desktop screen checks these. Items marked (inferred) had no
readable source.

## The eight that matter most here
1. From a selected row, "is this worth buying, and why?" takes two interactions or fewer; the row itself shows the
   estimate, its confidence and a one-line reason (NN/g interaction cost, data tables).
2. Review: one key approves or rejects and moves to the next; both sources and the AI's reason sit next to the
   decision without scrolling (NN/g heuristics 6 and 7).
3. Undo instead of alerts; an alert only for something that cannot be undone, with a button that names the action
   (HIG alerts).
4. Every figure says "estimate" and links its source; AI suggestions look different from facts and are never applied
   without the owner unless he turned Autopilot on (NN/g heuristics 1, 3, 5; CLAUDE.md rules 4 and 5).
5. The window always shows the scan state: last run, running and how far, next run, searches left (NN/g heuristic 1).
6. Loading never shows "nothing here"; each empty state says why and offers the next action (NN/g empty states).
7. One notification per event, chosen per kind; results arriving while the window is open appear in place, not as a
   notification; errors are never notifications (HIG notifications).
8. Tables: frozen header, visible and removable filters and sorts, a non-modal inspector, arrow-key row movement,
   right-aligned tabular money (NN/g data tables).

## Navigation
- The sidebar holds destinations only, at most two levels; nothing critical at its foot on a Mac (HIG sidebars).
- On Windows, Settings is the last item, pinned to the bottom of the navigation (Microsoft NavigationView).
- Counts appear as badges and clear as items are handled; the last view returns on launch (HIG).
- Every context-menu command is also reachable from a menu, toolbar or the palette (HIG context menus).

## Settings and onboarding
- Changes apply at once, no Save button; disabled settings say why (Microsoft app settings).
- Task options (sort, filters, columns) live with the task, not in Settings (HIG settings).
- The welcome sheet can be skipped, does not come back, and can be reopened (HIG onboarding).
- A key or permission is asked for when it is needed, with the reason (HIG onboarding).

## Platform
- Mac: app menu with Settings at Cmd+, ; trailing primary button in alerts (HIG).
- Windows: no app menu; commands in a command bar or the page; Ctrl shortcuts handled by the page; primary button
  first (Microsoft command bar).
- The menu bar extra / tray flyout is a quick view that dismisses on click-away and never the only home of a
  feature (inferred).

## Accessibility
- Text contrast at least 4.5:1 in light and dark; colour never the only signal (profit sign, grades) (HIG).
- Targets at least 24 px (WCAG 2.2 AA 2.5.8); focus always visible; every control named; full keyboard use (HIG,
  Microsoft).
- Reduce Motion respected; no auto-dismissing toasts for anything he must read (HIG).

## Long-running and background work
Researched Nov 23 2026: NN/g progress indicators (https://www.nngroup.com/articles/progress-indicators/) and response
times (https://www.nngroup.com/articles/response-times-3-important-limits/), Microsoft progress controls
(https://learn.microsoft.com/en-us/windows/apps/design/controls/progress-controls). Apple's page could not be read.
- A step of 10 seconds or more shows "N of M" or percent done, never a bare spinner (NN/g).
- A time estimate appears only when it is reasonably accurate, as a rough figure ("about 3 min"); otherwise counts.
  A permanent "estimating" fails this (NN/g).
- Every step has a text label and a mark: done, running, waiting, failed, skipped (NN/g).
- A scan is non-modal: a bar plus text, a clear Stop, and a status line that persists when he looks elsewhere
  (Microsoft, NN/g).
- Results appear as they arrive; one loading indicator at the top of the list, none per item (Microsoft).
- A press is acknowledged at once ("Starting…") (NN/g).
- A failure is visible state: the failed step, the reason, what was kept, and a retry for the failed part only (PAIR
  errors chapter, https://pair.withgoogle.com/chapter/errors-failing/).

## AI suggestions he approves
Researched Nov 23 2026: Microsoft's Guidelines for Human-AI Interaction (https://www.microsoft.com/en-us/haxtoolkit/library/,
G1–G18) and Google PAIR's guidebook (https://pair.withgoogle.com/chapter/explainability-trust/,
https://pair.withgoogle.com/chapter/feedback-controls/, https://pair.withgoogle.com/chapter/errors-failing/).
- Before the first suggestion the app says what the AI does and that it can be wrong (G1, G2).
- Verification is a category tied to an action ("Verified: the page text quoted below says so" / "Not verified: check
  the source"), never a score (PAIR explainability).
- The why and the quoted source, with its link, sit next to the suggestion (G11, PAIR).
- Accept, correct and dismiss are one action each (G7–G9); the suggested choice is preselected so one key accepts.
- "Cannot tell" is its own state with the reason and the choices; the AI does not guess (G10, CLAUDE.md rule 4).
- Autopilot is one switch that states its scope ("applies verified answers only"); everything it applied is listed with
  Undo and says Autopilot applied it (G17, PAIR feedback and control).
- The task can always be finished without the AI (PAIR).
- Cost is a secondary line, shown where it affects a decision (inferred).
