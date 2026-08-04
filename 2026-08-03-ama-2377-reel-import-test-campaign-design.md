# Reel Import & Watch Run-Through Test Campaign — Design

**Date:** 2026-08-03
**Status:** Approved (Approach A — corpus + staged pipeline)
**Execution machine:** Mac Mini (16GB, SSD1) — this spec is the handoff artifact; commit it into `amakaflow-automation/docs/` when execution starts.

## Goal

Thoroughly test AmakaFlow's workout-import pipeline (Instagram/TikTok/YouTube reels), manual workout creation, and the Apple Watch run-through experience — using a reusable corpus and scripted harnesses so the campaign is repeatable, not a one-off.

## Non-goals

Real-device TestFlight testing, Garmin export path (`watch-simulator` service), Android, performance/battery. Separate campaigns if wanted.

## Phase 1 — Test corpus (~300 reels)

Dataset: `amakaflow-automation/datasets/reel-corpus/corpus.jsonl`, one JSON object per line:

```json
{"id": "yt-strength-001", "url": "...", "platform": "youtube|tiktok|instagram",
 "style": "strength|hiit|cardio_run|yoga_mobility|circuit_mixed|adversarial",
 "expected_modality": "...", "caption_snapshot": "...", "transcript_snapshot": "...",
 "collected_via": "yt-dlp|chrome-session", "collected_at": "2026-08-.."}
```

- **Stratification:** YouTube ~150, TikTok ~90, Instagram ~60; workout styles roughly even; ~10% adversarial (non-workout fitness content, talking-head, no stated reps, non-English audio).
- **Collection:** YouTube via `yt-dlp` search queries per style (also yields transcripts). TikTok/Instagram harvested through David's logged-in Chrome session via Claude-in-Chrome (explore/hashtag pages) — both platforms block anonymous scraping.
- **Snapshot ground truth at collection time.** Reels get deleted; snapshots are the Tier-2 evidence. Three layers per reel: (1) caption text; (2) audio transcript — yt-dlp auto-subs for YouTube, downloaded video + Deepgram STT for TikTok/IG; (3) **sampled video frames (~1 fps via ffmpeg) → vision-model text extraction** for reels whose workout exists only as on-screen text overlays — a large share of fitness reels. Ground truth is collected **independently of the ingestor** (never reuse its extraction — that's grading its own homework).
- Demonstration-only reels (no caption, no speech, no overlay text) have no machine-readable ground truth: mark `ground_truth: none` and score only the *behavior* (graceful decline vs invented workout), not accuracy.

## Phase 2 — Bulk ingestion + tiered scoring

Runner: `amakaflow-automation/scripts/reel-campaign/` (Python). Posts each corpus URL to `workout-ingestor-api` on **staging** (staging-not-local-Docker rule). Bounded concurrency (be polite to staging), per-reel append-only results (resume-on-crash), raw responses archived.

- **Tier 1 (all reels, automatic):**
  1. Ingest succeeds (HTTP + no error payload).
  2. Output validates against the **real Pydantic model** (not the OpenAPI snapshot — AMA-2072 lesson).
  3. Workout **actually saves** via the save endpoint (catches the AMA-2095 un-saveable `kind:time` class).
  4. Maps to a watch payload without error.
- **Tier 2 (all reels, LLM judge):** compare parsed workout vs caption/transcript snapshot → plausibility score + failure-taxonomy label: missed-exercises, wrong-reps-sets, hallucinated-blocks, wrong-modality, garbage-handled-gracefully.
- **Tier 2 evidence:** judge compares parsed workout vs caption + transcript + frame-extracted overlay text (all independently collected). Scores exercise-level match: every exercise present, reps/sets/rounds correct, nothing invented.
- **Tier 3 (~30 stratified sample, manual):** David verifies parsed output against actual videos. **Doubles as judge calibration:** measure judge-vs-David agreement on the 30; ≥~90% → trust judge verdicts at scale; lower → fix judge prompt and re-run Tier 2 before believing its numbers.

**Output:** scored JSONL + markdown report (pass rates by platform × style, ranked failure taxonomy). Confirmed defects → AMA tickets with reel URL + raw response as repro.

## Phase 3 — UI end-to-end subset (~25 reels)

Real iPhone simulator, stratified across platform × style, **including several Phase-2 failures** (UI error handling is under test). Uses the proven sim recipe (`ios-sim-test-loop-recipe.md`): Debug build with Clerk keys, `+clerk_test` user with fixed OTP 424242, Maestro flows with permission pre-deny and onboarding-skip loop.

Per-reel flow: paste link into import surface → wait for ingest → verify workout detail renders sensibly → save → verify in Library. Screenshot every step; artifacts kept per reel.

## Phase 3b — Manual creation matrix (~30 cases)

Parameterized Maestro flow driving the builder:

- Every block type × edge values: 1 rep, 999 reps, seconds vs minutes durations, supersets, rest blocks, emoji/long names.
- One 50-exercise workout.
- Edit / reorder / delete after save.
- **Persistence across kill+relaunch** verified by reading the app's UserDefaults plist directly (`simctl get_app_container` + PlistBuddy — the AMA-1785 trick).

## Phase 3c — AI creation (~20 generations)

Coach/AI-generated workouts are a first-class creation path and get their own coverage (they were previously only implicit):

- **API level (~20 prompts):** drive the real generate path — chat-api SSE orchestrator on staging (NOT the dead iOS "Generate Program" 405 endpoint, AMA-2096; note `chat_beta_period` feature flag must be enabled for the test user). Prompts stratified across personas/styles (beginner strength, HIIT, run intervals, low-readiness easy day — reuse `amakaflow-docs/fixtures/coach/` fixtures). Same Tier-1 gate as imports: schema-valid → **actually saves** (the AMA-2095 un-saveable `kind:time` class originated here) → watch-mappable.
- **UI level (~10):** Suggest/Generate Workout flow on the iPhone sim per the proven Maestro recipe (agree → generate → review → Accept & Save → verify in Library with COACH source chip).

## Phase 3d — Library organization ("folder system")

After every save path (import, manual, AI), verify the workout lands in the Library **correctly organized**:

- Correct source chip: MANUAL / INSTAGRAM / TIKTOK / COACH per the DD spec.
- **Open question to resolve by testing: YouTube imports have no filter chip in the DD Library spec** (chips are All/Instagram/TikTok/Manual/Coach). Record what source chip/filter a YouTube import actually gets; if it's unfilterable or mislabeled, that's a defect ticket.
- Filter chips actually filter (each chip shows only its source; All shows everything).
- Search finds workouts by title, including emoji/long names from the builder matrix.
- Counts/meta lines correct ("8 blocks · 45 min · by you").
- Persistence: Library contents survive kill+relaunch.

## Phase 4 — Watch run-through (~10 workouts)

Paired iPhone + watchOS simulators. Maestro cannot drive watchOS → local **XCUITest** target (works locally; broken only on GitHub Actions runners — fine on the Mini).

Mix of imported and manually-built, time-based and rep-based workouts: send to watch → start → advance through intervals/sets → pause/resume mid-workout → complete → verify summary lands back on phone. Include one Watch DayState legacy-payload compatibility check (AMA-1932).

## Execution constraints (Mac Mini)

- One simulator pair at a time (16GB memory discipline).
- DerivedData / build products on SSD1.
- Clerk test users created per run, **deleted after** (clean-slate rule).
- Phase 1 and 2 may overlap (start ingesting YouTube while TikTok/IG collection continues); Phases 3/3b/4 wait on their inputs.
- Checkpoint report after each phase, mirrored to Telegram.

## Functionality coverage matrix (validated against docs 2026-08-03)

Validated against `amakaflow-docs`: `design/amakaflow-mvp-design-refresh/daily-driver-handoff/SPEC.md` (the converged DD spec), `features/workout-import.md`, `features/import-ux.md`, `features/coach-chat.md`, and the recent specs (`2026-08-01-manual-create-type-presets`, `2026-07-30-apple-watch-workoutkit-enhancements`).

| Functionality (per docs) | Where specced | Campaign coverage |
|---|---|---|
| Import from URL (IG/TikTok/YouTube) | DD Create sheet door 1; features/workout-import | Phases 1–3 |
| Import review → save → Library | DD Workout detail + Library | Phase 3 |
| Import error handling in UI | DD Create sheet processing states | Phase 3 (deliberate failure reels) |
| Import swap suggestions (equipment-aware) | DD Editor `import` mode | Phase 3 — verify swap UI when triggered |
| Build from scratch (all block types: Circuit·EMOM·AMRAP·Tabata·For Time·Sets·Superset·Rounds·Warm-up·Cool-down) | DD Editor `new` mode + 2026-08-01 type-presets spec | Phase 3b (matrix covers every type) |
| Edit existing workout | DD Editor `edit` mode | Phase 3b |
| AI/Coach generation → save | chat-api SSE (ADR-010); coach fixtures | Phase 3c |
| Library organization: source chips, filters, search | DD Library spec | Phase 3d |
| Start sheet: On phone / Push to watch | DD Workout detail Start sheet | Phase 4 |
| Watch run-through (intervals, pause/resume, complete) | DD Player + WorkoutKit spec | Phase 4 |
| Summary back to phone / Today timeline | DD Today diary | Phase 4 |

**Explicitly NOT covered** (docs features out of campaign scope): voice/scan create doors (other 2 of the 4 doors — stubs per DD spec), Garmin FIT export, RPE logging, backfill editor mode, gyms/equipment, Device queue screen, Strava pulls, activity mapping. If any of these are live in the current build, they stay out of scope for this campaign.

## Deliverables

1. `corpus.jsonl` (permanent asset, committed).
2. Ingestion runner + scoring scripts + LLM-judge prompt.
3. Maestro flows (import subset + builder matrix) in `amakaflow-automation/flows/ios/`.
4. XCUITest watch run-through target (iOS repo).
5. Per-phase markdown reports + AMA tickets for confirmed defects.
6. Post-campaign: promote surviving flows into the automation repo's regression suite.
