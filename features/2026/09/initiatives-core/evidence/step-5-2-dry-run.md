# Step 5.2 dry run — `agento.mjs initiative csv-suite` in a temp repo

Temp repo: `/tmp/agento-dryrun-W1abug` (roots `features/ issues/ initiatives/` each with `.gitkeep`), CLI from the worktree at commit `6e87b5a`, 2026-09-06.

## Run 1 — no roadmaps (exit 0)

```json
{
  "status": "ok",
  "errors": [],
  "features": [
    {
      "slug": "csv-export",
      "state": "unplanned",
      "roadmap": null,
      "branch": "feature/csv-export",
      "requires": [],
      "recommendedAfter": [],
      "wave": 1,
      "computedWave": 1,
      "order": 0,
      "blockedBy": [],
      "ready": true
    },
    {
      "slug": "csv-import",
      "state": "unplanned",
      "roadmap": null,
      "branch": "feature/csv-import",
      "requires": [],
      "recommendedAfter": [
        "csv-export"
      ],
      "wave": 1,
      "computedWave": 1,
      "order": 1,
      "blockedBy": [],
      "ready": true
    },
    {
      "slug": "csv-schedule",
      "state": "unplanned",
      "roadmap": null,
      "branch": "feature/csv-schedule",
      "requires": [
        "csv-export"
      ],
      "recommendedAfter": [
        "csv-import"
      ],
      "wave": 2,
      "computedWave": 2,
      "order": 2,
      "blockedBy": [
        "csv-export"
      ],
      "ready": false
    }
  ],
  "waves": [
    [
      "csv-export",
      "csv-import"
    ],
    [
      "csv-schedule"
    ]
  ],
  "next": "csv-export",
  "done": false,
  "initiative": {
    "slug": "csv-suite",
    "dir": "initiatives/2026/09/csv-suite",
    "breakdown": "initiatives/2026/09/csv-suite/breakdown.md",
    "created": "2026-09-05",
    "lastUpdated": "2026-09-05"
  },
  "anomalies": [],
  "root": "/tmp/agento-dryrun-W1abug",
  "configSource": null
}
```

## Run 2 — after a `status: complete` roadmap for `csv-export` and an `in-progress` roadmap for `csv-import`, both with `initiative: "csv-suite"` (exit 0)

```json
{
  "status": "ok",
  "errors": [],
  "features": [
    {
      "slug": "csv-export",
      "state": "complete",
      "roadmap": "features/2026/09/csv-export/roadmap.md",
      "branch": "feature/csv-export",
      "requires": [],
      "recommendedAfter": [],
      "wave": 1,
      "computedWave": 1,
      "order": 0,
      "blockedBy": [],
      "ready": false
    },
    {
      "slug": "csv-import",
      "state": "in-progress",
      "roadmap": "features/2026/09/csv-import/roadmap.md",
      "branch": "feature/csv-import",
      "requires": [],
      "recommendedAfter": [
        "csv-export"
      ],
      "wave": 1,
      "computedWave": 1,
      "order": 1,
      "blockedBy": [],
      "ready": false
    },
    {
      "slug": "csv-schedule",
      "state": "unplanned",
      "roadmap": null,
      "branch": "feature/csv-schedule",
      "requires": [
        "csv-export"
      ],
      "recommendedAfter": [
        "csv-import"
      ],
      "wave": 2,
      "computedWave": 2,
      "order": 2,
      "blockedBy": [],
      "ready": true
    }
  ],
  "waves": [
    [
      "csv-export",
      "csv-import"
    ],
    [
      "csv-schedule"
    ]
  ],
  "next": "csv-schedule",
  "done": false,
  "initiative": {
    "slug": "csv-suite",
    "dir": "initiatives/2026/09/csv-suite",
    "breakdown": "initiatives/2026/09/csv-suite/breakdown.md",
    "created": "2026-09-05",
    "lastUpdated": "2026-09-05"
  },
  "anomalies": [],
  "root": "/tmp/agento-dryrun-W1abug",
  "configSource": null
}
```
