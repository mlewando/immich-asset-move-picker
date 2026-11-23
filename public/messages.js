// Wording of the message after a Move / Give back (pure, unit-tested in test/messages.test.ts).

/** "'a.jpg'", "'a.jpg' + 1 more", "'a.jpg' + 3 more": the photos a click queued, by file name. */
export function photoNames(items, ids) {
  const wanted = new Set(ids);
  const names = items.filter((i) => wanted.has(i.id)).map((i) => i.fileName);
  if (names.length === 0) return '';
  return names.length === 1 ? `'${names[0]}'` : `'${names[0]}' + ${names.length - 1} more`;
}

/**
 * What a click queued: the photos (and their files when more than the photos: live photos,
 * stacks), and how many it found already queued.
 */
export function queuedMessage(items, { queued, queuedIds, alreadyQueued }, files) {
  const parts = [];
  if (queued > 0) {
    const names = photoNames(items, queuedIds);
    const count = `${queued} photo${queued === 1 ? '' : 's'}`;
    parts.push(`Queued ${names || count}${files > queued ? ` (${files} files)` : ''}`);
  }
  if (alreadyQueued) parts.push(`${alreadyQueued} already queued`);
  return parts.join(' • ');
}

/** The Give back question: the photo count, singular or plural. */
export function giveBackQuestion(count) {
  return `Give back ${count} photo${count === 1 ? '' : 's'}?`;
}
