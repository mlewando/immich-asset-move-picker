// Which member the page opens on: the one last viewed in this browser, else the 1st with photos
// on the timeline (the list starts with whoever sorts first, often an admin without any).

/** members: [{ id, hasPhotos }] in list order. Returns a member id, or null without members. */
export function startMember(members, lastViewedId) {
  const start = members.find((m) => m.id === lastViewedId) ?? members.find((m) => m.hasPhotos) ?? members[0];
  return start?.id ?? null;
}
