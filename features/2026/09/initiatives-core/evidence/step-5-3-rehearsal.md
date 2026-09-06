# Step 5.3 live rehearsal — `agento.mjs initiative rehearsal` in this worktree

Uncommitted `initiatives/2026/09/rehearsal/breakdown.md` written into the worktree at commit `cc7b4b6`, 2026-09-06; the directory was deleted afterwards (plan Decision 2).

## Run 1 — members `initiatives-core` (Requires: none) and `initiative-workflow` (Requires: initiatives-core) (exit 3)

This feature's real roadmap has no `initiative: "rehearsal"` header, so the header guard rejects the breakdown.

```json
{
  "status": "invalid",
  "errors": [
    "initiatives-core: roadmap features/2026/09/initiatives-core/roadmap.md has no initiative: header (expected \"rehearsal\")"
  ],
  "features": [
    {
      "slug": "initiatives-core",
      "state": "in-progress",
      "roadmap": "features/2026/09/initiatives-core/roadmap.md",
      "branch": "feature/initiatives-core",
      "requires": [],
      "recommendedAfter": [],
      "wave": 1,
      "computedWave": 1,
      "order": 0,
      "blockedBy": [],
      "ready": false
    },
    {
      "slug": "initiative-workflow",
      "state": "unplanned",
      "roadmap": null,
      "branch": "feature/initiative-workflow",
      "requires": [
        "initiatives-core"
      ],
      "recommendedAfter": [],
      "wave": 2,
      "computedWave": 2,
      "order": 1,
      "blockedBy": [
        "initiatives-core"
      ],
      "ready": false
    }
  ],
  "waves": [
    [
      "initiatives-core"
    ],
    [
      "initiative-workflow"
    ]
  ],
  "next": null,
  "done": false,
  "initiative": {
    "slug": "rehearsal",
    "dir": "initiatives/2026/09/rehearsal",
    "breakdown": "initiatives/2026/09/rehearsal/breakdown.md",
    "created": "2026-09-05",
    "lastUpdated": "2026-09-05"
  },
  "anomalies": [],
  "root": "/home/david/DP/agento-worktrees/plan-20260906-004606",
  "configSource": null
}
```

## Run 2 — members `rehearsal-a` (Requires: none) and `rehearsal-b` (Requires: rehearsal-a) (exit 0)

```json
{
  "status": "ok",
  "errors": [],
  "features": [
    {
      "slug": "rehearsal-a",
      "state": "unplanned",
      "roadmap": null,
      "branch": "feature/rehearsal-a",
      "requires": [],
      "recommendedAfter": [],
      "wave": 1,
      "computedWave": 1,
      "order": 0,
      "blockedBy": [],
      "ready": true
    },
    {
      "slug": "rehearsal-b",
      "state": "unplanned",
      "roadmap": null,
      "branch": "feature/rehearsal-b",
      "requires": [
        "rehearsal-a"
      ],
      "recommendedAfter": [],
      "wave": 2,
      "computedWave": 2,
      "order": 1,
      "blockedBy": [
        "rehearsal-a"
      ],
      "ready": false
    }
  ],
  "waves": [
    [
      "rehearsal-a"
    ],
    [
      "rehearsal-b"
    ]
  ],
  "next": "rehearsal-a",
  "done": false,
  "initiative": {
    "slug": "rehearsal",
    "dir": "initiatives/2026/09/rehearsal",
    "breakdown": "initiatives/2026/09/rehearsal/breakdown.md",
    "created": "2026-09-05",
    "lastUpdated": "2026-09-05"
  },
  "anomalies": [],
  "root": "/home/david/DP/agento-worktrees/plan-20260906-004606",
  "configSource": null
}
```
