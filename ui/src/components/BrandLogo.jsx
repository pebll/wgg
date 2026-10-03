/*
 * "WG Gefunden!" logo: a rounded house outline with a check mark ("found!"). The outline follows the text
 * color (currentColor, so it works on light and dark); the check mark and the "!" use the fixed brand accent.
 * The same mark lives in ui/src/assets/logo-mark.svg and public/favicon.svg.
 */

const TITLE = 'WG Gefunden!';

export function LogoMark({ size = 32, decorative = false, className }) {
  const a11y = decorative ? { 'aria-hidden': true, focusable: 'false' } : { role: 'img', 'aria-label': TITLE };
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      {...a11y}
    >
      {decorative ? null : <title>{TITLE}</title>}
      <path
        d="M32 8 L55 28 V52 a4 4 0 0 1 -4 4 H13 a4 4 0 0 1 -4 -4 V28 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinejoin="round"
      />
      <path
        d="M22 35 L29.5 42.5 L43 27.5"
        fill="none"
        stroke="var(--wgg-brand, #F2633A)"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function BrandLogo({ compact = false, size = 32 }) {
  if (compact) return <LogoMark size={size} />;
  return (
    <span className="brand">
      <LogoMark size={size} className="brand__mark" />
      <span className="brand__word" aria-hidden="true">
        <span className="brand__wg">WG</span> <span className="brand__name">Gefunden</span>
        <span className="brand__bang">!</span>
      </span>
    </span>
  );
}
