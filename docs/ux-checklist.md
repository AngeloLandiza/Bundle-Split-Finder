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
