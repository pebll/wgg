import { IconFlag } from '@douyinfe/semi-icons';
import CircleRating from './CircleRating.jsx';
import {
  deductionRows,
  deductionSummary,
  describeLlmModel,
  eligibilityLabel,
  isVerbindung,
  llmStatusLabel,
  verbindungTone,
} from '../services/format.js';

/** A list of positives (green flag) or red flags (red flag); the flag colors the heading and marks every entry. */
function List({ title, items, className, flagLabel }) {
  if (!items?.length) return null;
  return (
    <div className={`ai__list ${className ?? ''}`}>
      <h4 className="detail__subheading">
        <IconFlag className="ai__flag" role="img" aria-label={flagLabel} />
        {title}
      </h4>
      <ul className="detail__factlist ai__flaglist">
        {items.map((text, i) => (
          <li key={i}>
            <IconFlag className="ai__flag ai__flag--item" aria-hidden="true" />
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Side-panel block "AI assessment": Verbindung warning, evidence, fit score, summary, pros and red flags. */
export default function AiAssessment({ llm, badgeThreshold, now }) {
  if (!llm) return null;
  const status = llmStatusLabel(llm);
  const result = llm.status === 'done' ? llm.result : null;
  const tone = verbindungTone(result?.verbindungProbability, badgeThreshold);
  const model = describeLlmModel(llm, now);
  const ineligible = eligibilityLabel(result);
  const why = deductionRows(result);
  const flagged = isVerbindung(llm, badgeThreshold);

  return (
    <section className="ai" aria-label="AI assessment">
      <h3 className="detail__heading">AI assessment</h3>
      {status && (
        <div className={`detail__status${llm.status === 'failed' ? ' ai__status--failed' : ''}`} role="status">
          {status}
        </div>
      )}
      {result && (
        <>
          {ineligible && (
            <div className="ai__ineligible" role="alert">
              {ineligible}
            </div>
          )}
          {flagged && (
            <div className="ai__row">
              <span className={`ai__verbindung ai__verbindung--${tone}`}>Verbindung !</span>
            </div>
          )}
          {flagged && result.verbindungSignals.length > 0 && (
            <ul className="ai__signals">
              {result.verbindungSignals.map((signal, i) => (
                <li key={i}>
                  <q>{signal.replace(/^["„“']+|["“”']+$/g, '')}</q>
                </li>
              ))}
            </ul>
          )}
          <div className="ai__row">
            <span className="ai__label">Fit</span>
            <CircleRating score={result.fitScore} showValue />
          </div>
          {why.perfect && (
            <div className="ai__why">
              <h4 className="detail__subheading">Perfect match</h4>
            </div>
          )}
          {why.rows.length > 0 && (
            <details className="ai__why">
              <summary className="ai__why-summary">
                <span className="detail__subheading">Why not 10?</span>
                <span className="ai__why-total">{deductionSummary(why.rows)}</span>
              </summary>
              <ul className="ai__deductions">
                {why.rows.map((d, i) => (
                  <li key={i}>
                    <strong className="ai__deduction-points">{d.label}</strong> {d.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="ai__summary">{result.summary}</p>
          <List title="Positives" items={result.positives} className="ai__list--good" flagLabel="Green flag" />
          <List title="Red flags" items={result.redFlags} className="ai__list--bad" flagLabel="Red flag" />
          {result.truncated && (
            <div className="breakdown__note">
              The description was longer than {result.descriptionChars?.toLocaleString?.() ?? 'the limit'} characters;
              the AI saw only the start.
            </div>
          )}
          {model && <div className="ai__model">{model}</div>}
        </>
      )}
    </section>
  );
}
