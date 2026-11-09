# Glossary

**Member**:
A person with their own private Immich account. Their photos stay private.
_Avoid_: user (ambiguous with Immich users)

**Family account**:
The Immich account that holds the curated photos every member may see. It is never a picking
source.
_Avoid_: shared account

**Curator**:
The person allowed to move photos into the family account (access is controlled by the auth
proxy in front of the app).
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
Copy a member's photo into the family account, archive the original, hard-link the 2 files.
_Avoid_: copy, share

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
recorded, so a failure or restart resumes where it stopped.
