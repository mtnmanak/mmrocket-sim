/** Number each element by its nearest simulation, without per-motor array searches. */
export function simulationNumbers(doc, tag, owners = new WeakMap()) {
  const numbers = new WeakMap();
  const pending = [[doc.documentElement, undefined, undefined]];
  let ordinal = 0;
  while (pending.length) {
    const [el, inherited, inheritedOwner] = pending.pop();
    const number = el.tagName === tag ? ++ordinal : inherited;
    const owner = el.tagName === tag ? el : inheritedOwner;
    if (number !== undefined) { numbers.set(el, number); owners.set(el, owner); }
    const children = el.children;
    for (let i = children.length - 1; i >= 0; i--) pending.push([children[i], number, owner]);
  }
  return numbers;
}
