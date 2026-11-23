// What a modal (the phone menu, the phone job panel) covers is inert while it is open. 2 of them
// can cover the same elements, so an element stays inert until the last one lets it go.
const owners = new Map(); // owner name -> the elements it holds inert
const touched = new Set();

/** elements: what `owner` makes inert from now on, or null to let go of it all. */
export function holdInert(owner, elements) {
  if (elements) {
    owners.set(owner, [...elements]);
    for (const el of elements) touched.add(el);
  } else {
    owners.delete(owner);
  }
  const held = new Set([...owners.values()].flat());
  for (const el of touched) {
    el.toggleAttribute('inert', held.has(el));
    if (!held.has(el)) touched.delete(el);
  }
}
