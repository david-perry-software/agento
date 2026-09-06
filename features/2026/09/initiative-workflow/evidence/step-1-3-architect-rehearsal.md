# Step 1.3 — Architect CLI rehearsal (temp repo)

Date: 2026-09-05. Bare origin + clone under `/tmp`, roots `features/ issues/ initiatives/` with `.gitkeep`, branch `changes/initiative-demo-init`, `brief.md` (with `Source:` line) and a 3-member `breakdown.md` (demo-a → demo-b → demo-c) hand-written per the Architect agent step 6. CLI: `node <worktree>/scripts/agento.mjs` at commit `ffec7ae`. Script: the commands below were run in order; outputs are verbatim.

## 1. initiative demo-init before any files
$ node /home/david/DP/agento-worktrees/plan-20260906-021639/scripts/agento.mjs initiative demo-init
```json
{
  "status": "missing",
  "message": "No breakdown.md for initiative demo-init under initiatives/.",
  "root": "/tmp/agento-rehearsal-p49902/clone",
  "configSource": null
}
exit: 3
```

## 2. find demo-a (member slug free?)
$ node /home/david/DP/agento-worktrees/plan-20260906-021639/scripts/agento.mjs find demo-a
```json
{
  "status": "missing",
  "message": "No roadmap for slug demo-a under features/ or issues/, locally or on origin.",
  "root": "/tmp/agento-rehearsal-p49902/clone",
  "configSource": null
}
exit: 3
```

## 3. initiative demo-init after writing brief.md + breakdown.md
$ node /home/david/DP/agento-worktrees/plan-20260906-021639/scripts/agento.mjs initiative demo-init
```json
{
  "status": "ok",
  "errors": [],
  "features": [
    {
      "slug": "demo-a",
      "state": "unplanned",
      "roadmap": null,
      "branch": "feature/demo-a",
      "requires": [],
      "recommendedAfter": [],
      "wave": 1,
      "computedWave": 1,
      "order": 0,
      "blockedBy": [],
      "ready": true
    },
    {
      "slug": "demo-b",
      "state": "unplanned",
      "roadmap": null,
      "branch": "feature/demo-b",
      "requires": [
        "demo-a"
      ],
      "recommendedAfter": [],
      "wave": 2,
      "computedWave": 2,
      "order": 1,
      "blockedBy": [
        "demo-a"
      ],
      "ready": false
    },
    {
      "slug": "demo-c",
      "state": "unplanned",
      "roadmap": null,
      "branch": "feature/demo-c",
      "requires": [
        "demo-b"
      ],
      "recommendedAfter": [],
      "wave": 3,
      "computedWave": 3,
      "order": 2,
      "blockedBy": [
        "demo-b"
      ],
      "ready": false
    }
  ],
  "waves": [
    [
      "demo-a"
    ],
    [
      "demo-b"
    ],
    [
      "demo-c"
    ]
  ],
  "next": "demo-a",
  "done": false,
  "initiative": {
    "slug": "demo-init",
    "dir": "initiatives/2026/09/demo-init",
    "breakdown": "initiatives/2026/09/demo-init/breakdown.md",
    "created": "2026-09-05",
    "lastUpdated": "2026-09-05"
  },
  "anomalies": [],
  "root": "/tmp/agento-rehearsal-p49902/clone",
  "configSource": null
}
exit: 0
```

## 4. initiative (list mode)
$ node /home/david/DP/agento-worktrees/plan-20260906-021639/scripts/agento.mjs initiative
```json
{
  "status": "ok",
  "initiativesRoot": "initiatives",
  "items": [
    {
      "slug": "demo-init",
      "dir": "initiatives/2026/09/demo-init",
      "created": "2026-09-05",
      "lastUpdated": "2026-09-05",
      "total": 3,
      "complete": 0,
      "inFlight": 0,
      "ready": 1,
      "done": false,
      "valid": true
    }
  ],
  "root": "/tmp/agento-rehearsal-p49902/clone",
  "configSource": null
}
exit: 0
```

