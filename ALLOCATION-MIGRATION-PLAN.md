# Allocation Tracker -> People & Teams Migration Plan

## Branch: `allocation-refactor`

## Status Tracker

- [x] Phase 1: Board metadata extension
- [x] Phase 2: Server-side migration
- [x] Phase 3: Allocation tab on team detail
- [x] Phase 4: Org Allocation view
- [x] Phase 5: Settings + classification migration
- [x] Phase 6: Delete old module + cleanup

---

## Decisions Made

| Decision | Choice |
|----------|--------|
| Board ID source | Auto-extracted from URLs; support `/boards/123` and `rapidView=123`; allow manual fallback |
| Sub-team / sprint filter | Preserved as `sprintFilter` on board metadata |
| Multi-board teams | Per-board with board selector in UI |
| Calculation mode | `allocationMode` stored in team metadata, editable on Allocation tab |
| Org navigation | LDAP org hierarchy via OrgSelector (same as Team Directory) |
| Allocation storage prefix | `allocation/` within team-tracker storage (avoids collision with delivery sprint data) |
| Breaking change | Acceptable; no backward-compat shims for allocation-tracker config format |
| PR #471 coordination | Work on `allocation-refactor` branch; coordinate at end |
| CronJob URLs | Legacy route forwards from old paths |
| Demo mode | New fixtures under team-tracker fixture path |

---

## Phase 1: Board Metadata Extension

**Goal:** Extend the team board data model so boards carry `boardId` and optional `sprintFilter`.

### Data model change

Current: `boards: [{url, name}]`
New: `boards: [{url, name, boardId?, sprintFilter?}]`

### Files to modify

1. **`shared/server/team-store.js`**
   - Update board validation to accept `boardId` (number) and `sprintFilter` (string)
   - Auto-extract `boardId` from `url` on save if not explicitly provided
   - URL patterns to support:
     - `https://redhat.atlassian.net/jira/software/projects/RHOAIENG/boards/123` -> boardId 123
     - `https://redhat.atlassian.net/jira/software/c/projects/RHOAIENG/boards/123` -> boardId 123
     - `https://issues.redhat.com/secure/RapidBoard.jspa?rapidView=123` -> boardId 123
   - If extraction fails, leave `boardId` as null (UI will warn)

2. **`modules/team-tracker/server/index.js`**
   - PATCH `/:teamId/boards` endpoint — pass through new fields

3. **`modules/team-tracker/client/components/TeamBoardsEditor.vue`** (or equivalent)
   - Show extracted `boardId` as read-only badge on each board entry
   - Show warning if `boardId` couldn't be extracted
   - Add optional `sprintFilter` text input per board

4. **Tests**
   - Update board validation tests in team-store
   - Add URL extraction tests (multiple patterns, edge cases, failures)

### Team metadata extension

Add well-known metadata key `allocationMode` to teams:
- Values: `"points"` (default) or `"counts"`
- No field definition needed — this is a system property, not a custom field
- Editable on the Allocation tab (Phase 3)

---

## Phase 2: Server-Side Migration

**Goal:** Move allocation Jira client, orchestration, and classification code into team-tracker module. Adapt the refresh pipeline to read team/board config from team-store instead of allocation-tracker's own config.

### Directory structure

```
modules/team-tracker/server/allocation/
  jira-client.js        # Moved from allocation-tracker (has kanban + classification methods)
  orchestration.js      # Moved + adapted to use team-store boards
  classification.js     # Moved from allocation-tracker/server/jira/
  config.js             # Simplified — no more multi-project prefix logic
  classifier/
    classifier.js       # Moved from allocation-tracker/server/classification/
    index.js            # Classification endpoint handler
    jira-writer.js      # Refactored to use shared Jira auth pattern
```

### Key adaptations in orchestration.js

**Current flow (allocation-tracker):**
1. Read `config/orgs.json` -> get Jira project keys
2. For each project, read `teams.json` -> get enabled boards with boardId
3. For each board, fetch sprints, classify issues, write sprint files
4. Build per-project summary, then org summary

**New flow (team-tracker):**
1. Read teams from team-store (via `shared/server/team-store.js`)
2. For each team, read `boards` metadata -> get boardId + sprintFilter
3. For each board with a valid boardId, fetch sprints, classify issues
4. Write sprint files under `allocation/sprints/` prefix
5. Build per-team summary -> `allocation/team-{teamId}-summary.json`
6. Aggregate by org for org-level summaries -> `allocation/org-{orgKey}-summary.json`

### Storage layout (under team-tracker module storage)

```
allocation/
  config/
    classification.json           # Classification settings
  sprints/
    board-{boardId}.json          # Sprint index per board
    board-{boardId}-{filter}.json # Sprint index per board+filter
    {sprintId}.json               # Classified sprint issues + summary
  summaries/
    team-{teamId}.json            # Per-team allocation summary (active sprint)
    org-{orgKey}.json             # Per-org aggregate summary
    global.json                   # Global aggregate (all orgs)
```

### New API routes (mounted at `/api/modules/team-tracker/allocation/`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/refresh` | admin | Trigger allocation refresh (all teams or filtered) |
| GET | `/refresh/status` | public | Poll refresh state |
| GET | `/team/:teamId/summary` | auth | Team allocation summary |
| GET | `/org/:orgKey/summary` | auth | Org aggregate summary |
| GET | `/global/summary` | auth | Global aggregate summary |
| GET | `/board/:boardId/sprints` | auth | Sprints for a board (with optional sprintFilter query) |
| GET | `/sprints/:sprintId/issues` | auth | Classified issues for a sprint |
| POST | `/classify` | admin | Classify single issue |
| POST | `/classify/bulk` | admin | Bulk classify (from PR #471) |
| GET | `/classification/config` | admin | Classification settings |
| POST | `/classification/config` | admin | Save classification settings |

### Legacy route forwards (in dev-server.js LEGACY_FORWARDS)

```javascript
'/api/modules/allocation-tracker/refresh' -> '/api/modules/team-tracker/allocation/refresh'
'/api/modules/allocation-tracker/refresh/status' -> '/api/modules/team-tracker/allocation/refresh/status'
```

### Jira client notes

- Keep allocation's jira-client.js separate from team-tracker's existing Jira client
- It has methods team-tracker's client doesn't: `fetchBoardConfiguration`, `fetchFilterJql`, `fetchIssuesByJql` (needed for kanban)
- Refactor `jira-writer.js` to use `JIRA_EMAIL`/`JIRA_TOKEN` from the same env vars as team-tracker (already the case, just clean up the auth construction)

---

## Phase 3: Allocation Tab on Team Detail

**Goal:** Add an "Allocation" tab to `TeamRosterView.vue` showing 40/40/20 allocation data for the team's board(s).

### New components

1. **`modules/team-tracker/client/components/TeamAllocationTab.vue`**
   - Props: `team` (team object with boards, metadata), `teamId`
   - Board selector (dropdown, only shown if team has multiple boards with boardId)
   - Sprint selector (reuse pattern from allocation-tracker's SprintSelector)
   - Allocation bar (move `AllocationBar.vue` from allocation-tracker)
   - Bucket breakdown grid (move `BucketBreakdown.vue`)
   - Unestimated issues panel (move `UnestimatedPanel.vue`)
   - Completion summary for closed sprints (move `CompletionSummary.vue`)
   - MetricToggle for points/counts (move `MetricToggle.vue`)
   - `allocationMode` setting control (saves to team metadata)
   - Empty state: "No boards with Jira board IDs configured" with link to board settings

2. **Moved components** (from `modules/allocation-tracker/client/components/`):
   - `AllocationBar.vue` -> `modules/team-tracker/client/components/allocation/AllocationBar.vue`
   - `BucketBreakdown.vue` -> same pattern
   - `CompletionSummary.vue` -> same pattern
   - `UnestimatedPanel.vue` -> same pattern
   - `MetricToggle.vue` -> same pattern
   - `SprintSelector.vue` -> same pattern
   - `SprintStatusBadge.vue` -> same pattern
   - `IssueList.vue` -> same pattern

3. **New composable: `useAllocationData.js`**
   - Adapted from allocation-tracker's version
   - Simplified: no project/org navigation, just board+sprint data loading
   - Accepts teamId, fetches boards from team metadata, loads allocation data

### Integration into TeamRosterView.vue

- Add to `TAB_ICONS` object
- Add to `visibleTabs` computed (conditionally show if team has boards with boardIds)
- Add tab panel with lazy-load pattern (`v-if="tabActivated.allocation"` + `v-show`)
- Load allocation data when tab activates

### Client API additions

Add to `modules/team-tracker/client/services/` or extend existing API:
- `getAllocationSummary(teamId)` -> GET `/allocation/team/:teamId/summary`
- `getBoardSprints(boardId, sprintFilter?)` -> GET `/allocation/board/:boardId/sprints`
- `getSprintIssues(sprintId)` -> GET `/allocation/sprints/:sprintId/issues`
- `updateAllocationMode(teamId, mode)` -> PATCH team metadata

---

## Phase 4: Org Allocation View

**Goal:** New navigation item showing aggregate 40/40/20 allocation across all teams in an org.

### New nav item in module.json

```json
{
  "id": "org-allocation",
  "label": "Org Allocation",
  "icon": "chart-pie"
}
```

### New view: `OrgAllocationView.vue`

- Uses `OrgSelector` component (same as TeamDirectoryView)
- Shows:
  - Org-level aggregate allocation bar (from `/allocation/org/:orgKey/summary`)
  - Grid of team cards showing per-team allocation bars
  - Each team card links to that team's detail page Allocation tab
  - MetricToggle (org-level view uses points by default)
- Loading/empty states for orgs with no allocation data

### New components

1. **`AllocationTeamCard.vue`** — compact card showing team name + allocation bar + key stats
   - Adapted from allocation-tracker's `TeamCard.vue`
   - Click navigates to team detail Allocation tab

### Data flow

- On mount / org select: fetch `/allocation/org/:orgKey/summary`
- Summary includes per-team breakdown, allowing the card grid
- OrgSelector populated from roster orgs (same as TeamDirectoryView)

---

## Phase 5: Settings + Classification Migration

**Goal:** Move classification config and allocation settings into team-tracker's settings UI.

### Settings tab

Add "Allocation" or "Classification" tab to team-tracker's `AllocationTrackerSettings.vue` equivalent (or add to existing settings component).

**Contents:**
- Classification engine toggle (enabled/disabled)
- Confidence threshold slider
- Issue types to classify (checkboxes)
- Jira projects to classify (list editor)
- Bulk classification UI (from PR #471)

### Files

- Create `modules/team-tracker/client/components/AllocationSettings.vue`
- Register in team-tracker's `module.json` settingsComponent (or add as tab to existing settings)
- Wire up to `/allocation/classification/config` endpoints

---

## Phase 6: Delete Old Module + Cleanup

### Delete

- `modules/allocation-tracker/` — entire directory

### Update references

- `deploy/openshift/overlays/prod/cronjob-sync-refresh.yaml` — update API URLs
- `.github/workflows/build-images.yml` — remove allocation-tracker from change detection
- `.github/workflows/ci.yml` — if any allocation-tracker specific paths
- Any `CODEOWNERS` entries for allocation-tracker

### Legacy forwards in dev-server.js

Add to `LEGACY_FORWARDS`:
```javascript
'/api/modules/allocation-tracker/refresh': '/api/modules/team-tracker/allocation/refresh',
'/api/modules/allocation-tracker/refresh/status': '/api/modules/team-tracker/allocation/refresh/status',
```

### Demo fixtures

- Create `fixtures/team-tracker/allocation/` with sample data:
  - `config/classification.json`
  - `summaries/team-sample.json`
  - `sprints/sample-sprint.json`
- Update any existing fixture references

### Data migration script

Create `scripts/migrate-allocation-data.js`:
1. Read `data/allocation-tracker/teams.json` — extract boardId + sprintFilter per entry
2. Match to team-store teams by board name / display name similarity
3. Update matched teams' `boards` metadata with `boardId` and `sprintFilter`
4. Copy `data/allocation-tracker/sprints/` -> `data/team-tracker/allocation/sprints/`
5. Copy classification config
6. Print migration report (matched, unmatched, skipped)

### Test migration

Move relevant tests from `modules/allocation-tracker/__tests__/` to `modules/team-tracker/__tests__/`:
- `server/classification.test.js`
- `server/jira-client.test.js`
- `server/orchestration.test.js`
- `server/config.test.js`
- `client/AllocationBar.test.js`
- `client/BucketBreakdown.test.js`
- `client/CompletionSummary.test.js`
- `client/IssueList.test.js`
- `client/SprintSelector.test.js`
- `client/SprintStatusBadge.test.js`
- `client/UnestimatedPanel.test.js`
- `client/useAllocationData.test.js`
- Drop tests for removed views: `OrgDashboard.test.js`, `ProjectCard.test.js`, `ProjectDetail.test.js`, `TeamCard.test.js`, `TeamDetail.test.js`
- Drop `FilterEditor.test.js`, `FilterSelector.test.js`, `useSavedFilters.test.js` (filter system removed)
- Update imports and paths in all moved tests
- Write new tests for:
  - Board URL extraction (boardId parsing)
  - TeamAllocationTab integration
  - OrgAllocationView integration

---

## Key File Reference

### Allocation-tracker files to migrate

| Source | Destination | Notes |
|--------|-------------|-------|
| `server/jira/jira-client.js` | `team-tracker/server/allocation/jira-client.js` | Keep as-is (has kanban support) |
| `server/jira/orchestration.js` | `team-tracker/server/allocation/orchestration.js` | Adapt to use team-store |
| `server/jira/classification.js` | `team-tracker/server/allocation/classification.js` | Move as-is |
| `server/jira/config.js` | `team-tracker/server/allocation/config.js` | Simplify (remove multi-project prefix) |
| `server/classification/classifier.js` | `team-tracker/server/allocation/classifier/classifier.js` | Move as-is |
| `server/classification/index.js` | `team-tracker/server/allocation/classifier/index.js` | Move as-is |
| `server/classification/jira-writer.js` | `team-tracker/server/allocation/classifier/jira-writer.js` | Refactor auth |
| `client/components/AllocationBar.vue` | `team-tracker/client/components/allocation/AllocationBar.vue` | Move as-is |
| `client/components/BucketBreakdown.vue` | Same pattern | Move as-is |
| `client/components/CompletionSummary.vue` | Same pattern | Move as-is |
| `client/components/IssueList.vue` | Same pattern | Move as-is |
| `client/components/MetricToggle.vue` | Same pattern | Move as-is |
| `client/components/SprintSelector.vue` | Same pattern | Move as-is |
| `client/components/SprintStatusBadge.vue` | Same pattern | Move as-is |
| `client/components/UnestimatedPanel.vue` | Same pattern | Move as-is |

### Allocation-tracker files to DROP

| File | Reason |
|------|--------|
| `client/views/OrgDashboardView.vue` | Replaced by OrgAllocationView |
| `client/views/ProjectDetailView.vue` | Project concept removed |
| `client/views/TeamDetailView.vue` | Replaced by Allocation tab on team detail |
| `client/components/OrgDashboard.vue` | Replaced by OrgAllocationView |
| `client/components/ProjectCard.vue` | Project concept removed |
| `client/components/ProjectDetail.vue` | Project concept removed |
| `client/components/TeamCard.vue` | Replaced by AllocationTeamCard |
| `client/components/TeamDetail.vue` | Replaced by TeamAllocationTab |
| `client/components/FilterEditor.vue` | Filter system removed |
| `client/components/FilterSelector.vue` | Filter system removed |
| `client/components/AllocationTrackerSettings.vue` | Replaced by AllocationSettings in team-tracker |
| `client/composables/useSavedFilters.js` | Filter system removed |
| `client/index.js` | Module entry point removed |
| `client/services/api.js` | Replaced by team-tracker API service |
| `server/index.js` | Routes migrated to team-tracker |
| `module.json` | Module removed |
| `JIRA-AUTOMATION-SETUP.md` | Move to team-tracker docs if still relevant |
| `CLASSIFICATION-SYNC.md` | Move to team-tracker docs if still relevant |
