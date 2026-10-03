/**
 * Human-readable multi-line text for one listing.
 * @param {Partial<import('../provider/wgGesucht.js').Listing>} l
 * @returns {string}
 */
export function formatListing(l) {
  const address = [l.district, l.street].filter(Boolean).join(', ');
  const available = l.availableFrom
    ? `available ${l.availableFrom}${l.availableUntil ? ` - ${l.availableUntil}` : ''}`
    : null;
  const facts = [
    l.priceRaw ?? (l.price != null ? `${l.price} €` : null),
    l.sizeRaw ?? (l.size != null ? `${l.size} m²` : null),
    address || null,
    available,
    l.flatmatesRaw,
    l.onlineRaw,
  ].filter(Boolean);
  return [`- ${l.title}`, facts.length ? `  ${facts.join(' | ')}` : null, `  ${l.link}`].filter(Boolean).join('\n');
}
