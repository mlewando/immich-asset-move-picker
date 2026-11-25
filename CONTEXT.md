# Glossary

**Member**:
A person with their own private Immich account. Their photos stay private.
_Avoid_: user (ambiguous with Immich users)

**Family account**:
The Immich account that holds the curated photos every member may see. It is never a picking
source.
_Avoid_: shared account

**Curator**:
The person allowed to move photos into the family account (a member of the allowed groups at the
OpenID Connect provider). In the login code (`req.user`, `user` in log lines) "user" is the
logged-in curator, as the OIDC libraries call it.
_Avoid_: admin

**Picker**:
This app: the curator's web page to browse a member's timeline and move or give back photos.

**Original**:
The member's own asset that was moved. After a move it is archived (not deleted), so the
member's phone still finds it and never uploads it again.

**Family copy**:
The asset in the family account created from 1 or more originals. Shares its file with every
original through a hard link.
_Avoid_: duplicate

**Move to family**:
Copy a member's photo into the family account (into a family album, rarely none), archive the
original, hard-link the 2 files.
_Avoid_: copy, share

**Family album**:
An album owned by the family account, that a move puts the family copies into. Picked or created
(by name) in the Move dialog. The picker never deletes one.

**Near (a family album)**:
A member's grid filtered to a family album's days, from its first to its last photo day, plus the
**surround**: days before and after it. Marked by 2 dividers (where the album's days end and
start). The **suggested album** is the family album with the latest days whose own days (no
surround) hold member photos the family lacks.

**Source album**:
The member's album the grid is filtered by when moving. Deleted at the curator's request once
nothing in it is on a timeline any more; an **album cleanup** (request) waits for that in the
queue.
_Avoid_: member album (any album holding a member's photos)

**Give back**:
Reverse a move: permanently delete the family copy, return every original to its owner's
timeline.
_Avoid_: undo, delete

**Pair**:
The link original ⇄ family copy. Never stored: worked out from Immich on the fly. A family copy's
originals are the other accounts' archived assets with exactly the same bytes (same checksum).
1 family copy may have many originals (the same bytes held by 2 members, e.g. AirDrop).

**Hard link**:
2 file names pointing at 1 file, so a moved photo is stored once. Deleting 1 name keeps the
other.
_Avoid_: dedup, symlink

**Job**:
1 queued Move to family or Give back, run by the in-process worker step by step; each step is
recorded, so a failure or restart resumes where it stopped. A move's last step waits for Immich
to make the family copy's thumbnails (shown as "processing thumbnails"), without holding up other
jobs.

**Job history**:
Everything that happened to 1 job, oldest first: queued (by whom), each step done, waits,
failures, retries, resumes after a restart. Kept after the job is done, for a set number of days.
_Avoid_: log (the app's own log lines are a different thing)

**Transient failure**:
A failure that usually passes on its own: Immich not answering or restarting, a dropped
connection, a file that Storage Template Migration moved meanwhile. The job is tried again on its
own a few times (an **automatic retry**) before it fails.
_Avoid_: flaky, temporary error

**Failed** (job):
A job that stopped and waits for the curator's **Retry**: a refusal (e.g. the photo is in the
trash), or a transient failure that kept failing. Retry starts the automatic retries afresh.

**Paused**:
No job runs because the picker can't vouch for Immich right now: it does not answer, or its
version or database is not what the picker was tested with. The picker is read-only at the same
time (no new Move to family or Give back). Jobs keep their place and go on by themselves once the
check passes; **Check again** runs the check at once.
_Avoid_: stopped, down

**Queue page**:
The picker's page listing every job (failed, in progress, done) with its photo, state and job
history.
