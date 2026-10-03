import { verbindungBadge } from '../services/format.js';

/** Small warning badge "Verbindung? 45 %" from the configured threshold on; renders nothing below it. */
export default function VerbindungBadge({ llm, threshold }) {
  const badge = verbindungBadge(llm, threshold);
  if (!badge) return null;
  const signals = llm.result.verbindungSignals ?? [];
  return (
    <span
      className={`verbindung-badge verbindung-badge--${badge.tone}`}
      title={signals.length > 0 ? signals.join(' | ') : 'Possible Studentenverbindung'}
    >
      {badge.text}
    </span>
  );
}
