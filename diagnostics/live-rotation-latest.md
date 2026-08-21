# Live Rotator Diagnostic

Run UTC: 2026-08-21T02:56:26Z

## Real rotation output
```text
Connecting to fdaa:55:aa13:a7b:89d:7c85:3b37:2...
OK chat-tag-bot-new: 68362dec075728 -> d89639da19e0e8
OK chat-tag-new: 48e7292b92d9d8 -> 48e7292b92d9d8
OK discord-stream-hub-new: d895de5b227d28 -> d895de5b227d28
OK dsh-clip-worker: 86de05f7ee61d8 -> 8324e1b7759d18
OK hearmeout-main: d8d17d6c7e5068 -> d8d17d6c7e5068
OK hmo-dj-worker: 85e204f4442908 -> 85e204f4442908
OK streamweaver-new: 080e967ea95558 -> 080e967ea95558
WARN chat-tag-new: Active Machine 48e7292b92d9d8 has a Fly volume mount. Clone handoff is skipped because the standby may not be able to start while the old Machine owns the volume. Restarting the active Machine in place because clone handoff is unsafe for this app.
WARN discord-stream-hub-new: Active Machine d895de5b227d28 has a Fly volume mount. Clone handoff is skipped because the standby may not be able to start while the old Machine owns the volume. Restarting the active Machine in place because clone handoff is unsafe for this app.
WARN hearmeout-main: Active Machine d8d17d6c7e5068 has a Fly volume mount. Clone handoff is skipped because the standby may not be able to start while the old Machine owns the volume. Restarting the active Machine in place because clone handoff is unsafe for this app.
WARN hmo-dj-worker: Active Machine 85e204f4442908 has a Fly volume mount. Clone handoff is skipped because the standby may not be able to start while the old Machine owns the volume. Restarting the active Machine in place because clone handoff is unsafe for this app.
WARN streamweaver-new: Active Machine 080e967ea95558 has a Fly volume mount. Clone handoff is skipped because the standby may not be able to start while the old Machine owns the volume. Restarting the active Machine in place because clone handoff is unsafe for this app.
```

## Rotator persisted runtime state
```json
Connecting to fdaa:55:aa13:a7b:89d:7c85:3b37:2...
{
  "updatedAt": "2026-08-21T02:56:25.944Z",
  "totalRuns": 21,
  "currentStatus": "success",
  "lastTrigger": "cli",
  "lastStartedAt": "2026-08-21T02:54:08.836Z",
  "lastFinishedAt": "2026-08-21T02:56:25.944Z",
  "lastDurationMs": 137108,
  "nextRunAt": "2026-08-21T14:56:25.944Z",
  "lastRunLines": [
    "OK chat-tag-bot-new handoff: 68362dec075728 -> d89639da19e0e8",
    "OK chat-tag-new restart: 48e7292b92d9d8 -> 48e7292b92d9d8 warn=1",
    "OK discord-stream-hub-new restart: d895de5b227d28 -> d895de5b227d28 warn=1",
    "OK dsh-clip-worker handoff: 86de05f7ee61d8 -> 8324e1b7759d18",
    "OK hearmeout-main restart: d8d17d6c7e5068 -> d8d17d6c7e5068 warn=1",
    "OK hmo-dj-worker restart: 85e204f4442908 -> 85e204f4442908 warn=1",
    "OK streamweaver-new restart: 080e967ea95558 -> 080e967ea95558 warn=1"
  ]
}```

## Managed Fly apps after rotation

### chat-tag-bot-new
```text
3 machines have been retrieved from app chat-tag-bot-new.
View them in the UI here (​https://fly.io/apps/chat-tag-bot-new/machines/)

[1mchat-tag-bot-new[0m
 ID             │ NAME                 │ STATE   │ CHECKS │ REGION │ ROLE │ IMAGE                                                  │ IP ADDRESS                       │ VOLUME │ CREATED              │ LAST UPDATED         │ PROCESS GROUP │ SIZE                
 d89639da19e0e8 │ aged-resonance-4025  │ started │ 1/1    │ iad    │      │ chat-tag-bot-new:deployment-01M0DR1QP094DN2DC33DN1CHH9 │ fdaa:55:aa13:a7b:529:7448:d533:2 │        │ 2026-07-24T14:31:26Z │ 2026-08-21T02:54:12Z │ app           │ shared-cpu-1x:512MB 
 68362dec075728 │ green-wind-7640      │ stopped │ 0/1    │ iad    │      │ chat-tag-bot-new:deployment-01M0DR1QP094DN2DC33DN1CHH9 │ fdaa:55:aa13:a7b:6d5:9675:b93b:2 │        │ 2026-07-27T12:25:17Z │ 2026-08-21T02:54:20Z │ app           │ shared-cpu-1x:512MB 
 080d6eef522618 │ broken-mountain-2820 │ stopped │ 0/1    │ iad    │      │ chat-tag-bot-new:deployment-01M0DR1QP094DN2DC33DN1CHH9 │ fdaa:55:aa13:a7b:846:4653:3811:2 │        │ 2026-07-24T02:28:00Z │ 2026-08-20T03:01:35Z │ app           │ shared-cpu-1x:512MB 

```

### chat-tag-new
```text
1 machines have been retrieved from app chat-tag-new.
View them in the UI here (​https://fly.io/apps/chat-tag-new/machines/)

[1mchat-tag-new[0m
 ID             │ NAME              │ STATE   │ CHECKS │ REGION │ ROLE │ IMAGE                                              │ IP ADDRESS                       │ VOLUME               │ CREATED              │ LAST UPDATED         │ PROCESS GROUP │ SIZE                 
 48e7292b92d9d8 │ floral-glade-7337 │ started │ 1/1    │ iad    │      │ chat-tag-new:deployment-01M0DQXS3G1H1CDW1XERAEMFYZ │ fdaa:55:aa13:a7b:591:2a6b:dafe:2 │ vol_vwn2529mw5w0wq8v │ 2026-07-07T16:40:38Z │ 2026-08-21T02:54:30Z │ app           │ shared-cpu-2x:2048MB 

```

### discord-stream-hub-new
```text
1 machines have been retrieved from app discord-stream-hub-new.
View them in the UI here (​https://fly.io/apps/discord-stream-hub-new/machines/)

[1mdiscord-stream-hub-new[0m
 ID             │ NAME           │ STATE   │ CHECKS │ REGION │ ROLE │ IMAGE                                                        │ IP ADDRESS                      │ VOLUME               │ CREATED              │ LAST UPDATED         │ PROCESS GROUP │ SIZE                 
 d895de5b227d28 │ green-moon-398 │ started │ 1/1    │ iad    │      │ discord-stream-hub-new:deployment-01M0DR2GQ553Y4MH4C7K1JED3E │ fdaa:55:aa13:a7b:84a:ca50:d37:2 │ vol_vz8ey6wpj0nl7zqv │ 2026-07-24T06:35:17Z │ 2026-08-21T02:54:46Z │ app           │ shared-cpu-2x:2048MB 

```

### dsh-clip-worker
```text
2 machines have been retrieved from app dsh-clip-worker.
View them in the UI here (​https://fly.io/apps/dsh-clip-worker/machines/)

[1mdsh-clip-worker[0m
 ID             │ NAME             │ STATE   │ CHECKS │ REGION │ ROLE │ IMAGE                                                 │ IP ADDRESS                       │ VOLUME │ CREATED              │ LAST UPDATED         │ PROCESS GROUP │ SIZE                 
 86de05f7ee61d8 │ cold-meadow-1697 │ stopped │ 0/1    │ iad    │      │ dsh-clip-worker:deployment-01M0DQYN543EC5YF7E81GMB8QG │ fdaa:55:aa13:a7b:6d6:e27b:3a50:2 │        │ 2026-07-02T10:17:14Z │ 2026-08-21T02:55:18Z │ app           │ shared-cpu-2x:2048MB 
 8324e1b7759d18 │ red-field-8709   │ started │ 1/1    │ iad    │      │ dsh-clip-worker:deployment-01M0DQYN543EC5YF7E81GMB8QG │ fdaa:55:aa13:a7b:42c:2ef2:eb5a:2 │        │ 2026-06-28T17:16:15Z │ 2026-08-21T02:55:05Z │ app           │ shared-cpu-2x:2048MB 

```

### hearmeout-main
```text
1 machines have been retrieved from app hearmeout-main.
View them in the UI here (​https://fly.io/apps/hearmeout-main/machines/)

[1mhearmeout-main[0m
 ID             │ NAME              │ STATE   │ CHECKS │ REGION │ ROLE │ IMAGE                                                │ IP ADDRESS                       │ VOLUME               │ CREATED              │ LAST UPDATED         │ PROCESS GROUP │ SIZE                 
 d8d17d6c7e5068 │ winter-glade-1187 │ started │ 1/1    │ iad    │      │ hearmeout-main:deployment-01M0FX09Q1V0RQRF5TD3Z9VE46 │ fdaa:55:aa13:a7b:57f:436c:76f8:2 │ vol_vlypz052m7d3x1d4 │ 2026-05-22T05:05:40Z │ 2026-08-21T02:55:27Z │ app           │ shared-cpu-1x:1024MB 

```

### hmo-dj-worker
```text
1 machines have been retrieved from app hmo-dj-worker.
View them in the UI here (​https://fly.io/apps/hmo-dj-worker/machines/)

[1mhmo-dj-worker[0m
 ID             │ NAME            │ STATE   │ CHECKS │ REGION │ ROLE │ IMAGE                                               │ IP ADDRESS                       │ VOLUME               │ CREATED              │ LAST UPDATED         │ PROCESS GROUP │ SIZE                 
 85e204f4442908 │ little-sun-5353 │ started │ 1/1    │ iad    │      │ hmo-dj-worker:deployment-01M0FX09Q3NZVBY12KJA34HS7N │ fdaa:55:aa13:a7b:2fc:a5e7:5a3c:2 │ vol_rkgne6q1ooml5524 │ 2026-06-26T16:54:16Z │ 2026-08-21T02:55:48Z │ app           │ shared-cpu-4x:4096MB 

```

### streamweaver-new
```text
1 machines have been retrieved from app streamweaver-new.
View them in the UI here (​https://fly.io/apps/streamweaver-new/machines/)

[1mstreamweaver-new[0m
 ID             │ NAME              │ STATE   │ CHECKS │ REGION │ ROLE │ IMAGE                                                  │ IP ADDRESS                      │ VOLUME               │ CREATED              │ LAST UPDATED         │ PROCESS GROUP │ SIZE                 
 080e967ea95558 │ divine-water-5152 │ started │ 1/1    │ iad    │      │ streamweaver-new:deployment-01M0GZSYNBX7845G5EX3TB93T5 │ fdaa:55:aa13:a7b:122:4026:766:2 │ vol_4ojp7z8jy1mwjoxr │ 2026-07-24T15:21:28Z │ 2026-08-21T02:56:11Z │ app           │ shared-cpu-2x:2048MB 

```

## StreamWeaver signal scheduler
```json
Connecting to fdaa:55:aa13:a7b:122:4026:766:2...
{
  "missing": true,
  "path": "/data/runtime/global/signal-scheduler.json",
  "error": "ENOENT"
}
```

## StreamWeaver signal hint history (latest 25)
```json
Connecting to fdaa:55:aa13:a7b:122:4026:766:2...
{
  "missing": true,
  "path": "/data/runtime/global/signal-hint-history.json",
  "error": "ENOENT"
}
```
