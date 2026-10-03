import { verbindungBadge } from '../services/format.js';

/** Small warning badge "Verbindung !" from the configured threshold on; renders nothing below it. */
export default function VerbindungBadge({ llm, threshold }) {
  const badge = verbindungBadge(llm, threshold);
  if (!badge) return null;
  const signals = llm.result.verbindungSignals ?? [];
  return (
    <span
      className={`verbindung-badge verbindung-badge--${badge.tone}`}
      title={signals.length > 0 ? signals.slice(0, 3).join(' | ') : 'Possible Studentenverbindung'}
    >
      {badge.text}
    </span>
  );
}
