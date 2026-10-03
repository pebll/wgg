import { locateListing } from '../geocoding/locate.js';
import { createCityAnchors } from '../geocoding/city.js';
import {
  selectRowsForEvaluation,
  storeListingDetails,
  updateListingGeo,
} from '../services/listings/listingsStorage.js';
import { evaluateForUser } from '../evaluation/pipeline.js';
import logger from '../services/logger.js';

/** "80999 München Beispielviertel" -> "München Beispielviertel" (the postcode carries no information for the geocoder). */
const stripPostcode = (s) => (s ? s.replace(/^\d{5}\s*/, '').trim() || null : null);

/**
 * The detail page's street is worth geocoding again when the card gave only a district centroid (or nothing), or
 * when the detail street has a house number the card street lacks.
 */
function isMorePrecise(row, street) {
  if (!street) return false;
  if (row.geo_precision !== 'address') return true;
  return /\d/.test(street) && !/\d/.test(row.street ?? '');
}

/**
 * Stores a parsed detail page for a listing (once, for everybody), geocodes the detail address when it is more precise
 * than what the card gave (the geocoder rate-limits itself), and re-runs the rule-based evaluation for every user who
 * has the listing in their view, so the keyword exclusion also sees the full description.
 *
 * @param {object} row The stored listing row.
 * @param {import('../provider/wgGesuchtDetail.js').DetailPage} page
 * @param {{contexts: import('../users/directory.js').UserContext[]|(() => import('../users/directory.js').UserContext[]),
 *   geocoder: import('../geocoding/geocoder.js').Geocoder, now?: number}} deps
 * @returns {Promise<{regeocoded: boolean, excluded: Record<string, string|null>}>} `excluded`: per user, the
 *   exclusion reason of the new evaluation (null: not excluded).
 */
export async function applyDetails(row, page, { contexts, geocoder, now = Date.now() }) {
  storeListingDetails(row.id, page, now);

  let regeocoded = false;
  const street = page.address?.street ?? null;
  if (isMorePrecise(row, street)) {
    const district = stripPostcode(page.address?.postcodeCity) ?? row.district;
    const { city, point } = await createCityAnchors(geocoder).forUrl(row.search_url);
    const geo = await locateListing({ street, district }, { geocoder, target: point, city });
    // A failed lookup keeps what the card gave; only a better (or equal) result replaces it.
    if (geo && (geo.precision === 'address' || row.geo_precision !== 'address')) {
      updateListingGeo(row.id, geo);
      regeocoded = true;
    }
  }

  const excluded = {};
  for (const ctx of typeof contexts === 'function' ? contexts() : contexts) {
    for (const own of selectRowsForEvaluation({ userId: ctx.userId, providerIds: [row.provider_id] })) {
      try {
        excluded[ctx.userId] = evaluateForUser(ctx, own, now).excluded ?? null;
      } catch (error) {
        logger.error(`Evaluating listing ${row.provider_id} for ${ctx.userId} failed: ${error.message}`);
      }
    }
  }
  return { regeocoded, excluded };
}
