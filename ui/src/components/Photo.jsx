import { useState } from 'react';
import { photoFailed, safeLink } from '../services/format.js';

/**
 * Photo that falls back to a placeholder when missing or when the image fails. The failure is remembered per URL,
 * so reusing the component for another listing (side panel) retries instead of staying on "No photo".
 * `eager` disables lazy loading for photos that are always visible; `fallback` is the placeholder text.
 */
export default function Photo({ src, alt, className, eager = false, fallback = 'No photo' }) {
  const [failedUrl, setFailedUrl] = useState(null);
  const url = safeLink(src);
  if (!url || photoFailed(failedUrl, url)) return <div className={`${className} ${className}--empty`}>{fallback}</div>;
  return (
    <img
      className={className}
      src={url}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      referrerPolicy="no-referrer"
      onError={() => setFailedUrl(url)}
    />
  );
}
