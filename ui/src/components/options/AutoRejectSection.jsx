import { useEffect, useState } from 'react';
import { Slider, Switch, Tag, Toast } from '@douyinfe/semi-ui-19';
import Section from './Section.jsx';
import { errorMessage } from '../../services/xhr.js';
import { AUTO_REJECT_SLIDERS, autoRejectBody, validateAutoRejectForm } from '../../services/options.js';

const percent = (v) => `${Math.round(v * 100)} %`;
const months = (n) => `${n} ${n === 1 ? 'month' : 'months'}`;

function scrollToScoring(event) {
  event.preventDefault();
  document.getElementById('options-scoring')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export default function AutoRejectSection({ settings, defaults, save }) {
  const [form, setForm] = useState(settings.autoReject);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(settings.autoReject), [settings.autoReject]);
  const setV = (patch) => setForm((f) => ({ ...f, verbindung: { ...f.verbindung, ...patch } }));
  const setS = (patch) => setForm((f) => ({ ...f, shortTerm: { ...f.shortTerm, ...patch } }));
  const { verbindung: v, shortTerm: s } = form;
  const keywords = settings.scoring.keywords;

  const onSave = async () => {
    const problems = validateAutoRejectForm(form);
    setErrors(problems);
    if (problems.length > 0) return;
    setSaving(true);
    try {
      await save(autoRejectBody(form));
      Toast.success('Auto-reject saved. Your offers are being re-checked.');
    } catch (e) {
      setErrors([errorMessage(e, 'Could not save auto-reject.')]);
    }
    setSaving(false);
  };

  return (
    <Section
      title="Auto-reject"
      intro={
        <p>
          Offers that match are hidden automatically with the reason shown. You can list them with “Show removed
          automatically” on the Offers tab and restore any of them. Saving re-checks your offers.
        </p>
      }
      errors={errors}
      saving={saving}
      onSave={onSave}
      onReset={() => setForm(defaults.autoReject)}
    >
      <label className="options__inline">
        Reject Verbindungen automatically
        <Switch
          checked={v.enabled}
          onChange={(enabled) => setV({ enabled })}
          aria-label="Reject Verbindungen automatically"
        />
      </label>
      <div className={`options__sub${v.enabled ? '' : ' options__sub--off'}`}>
        <label className="options__inline">
          Word list
          <Switch
            checked={v.keywords}
            disabled={!v.enabled}
            onChange={(on) => setV({ keywords: on })}
            aria-label="Word list"
          />
        </label>
        <div className="options__group">
          <div className="options__tags" aria-label="Word list (read-only)">
            {keywords.length === 0 && <span className="options__hint">The word list is empty.</span>}
            {keywords.map((k) => (
              <Tag key={k}>{k}</Tag>
            ))}
          </div>
          <div className="options__hint">
            Offers mentioning one of these words.{' '}
            <a href="#options-scoring" onClick={scrollToScoring}>
              edit in Scoring
            </a>
          </div>
        </div>
        <label className="options__inline">
          AI check
          <Switch checked={v.ai} disabled={!v.enabled} onChange={(ai) => setV({ ai })} aria-label="AI check" />
        </label>
        <div className="options__group">
          <strong>AI confidence ≥ {percent(v.aiThreshold)}</strong>
          <div className="options__slider">
            <Slider
              {...AUTO_REJECT_SLIDERS.threshold}
              value={v.aiThreshold}
              disabled={!v.enabled || !v.ai}
              tipFormatter={percent}
              getAriaValueText={percent}
              aria-label="AI confidence threshold"
              onChange={(aiThreshold) => setV({ aiThreshold: Math.round(aiThreshold * 100) / 100 })}
            />
          </div>
          <div className="options__hint">
            Rejects when the AI is at least this sure that the offer is from a Studentenverbindung.
          </div>
        </div>
      </div>

      <label className="options__inline">
        Reject short-term rentals
        <Switch checked={s.enabled} onChange={(enabled) => setS({ enabled })} aria-label="Reject short-term rentals" />
      </label>
      <div className={`options__sub${s.enabled ? '' : ' options__sub--off'}`}>
        <div className="options__group">
          <strong>Minimum stay: {months(s.minMonths)}</strong>
          <div className="options__slider">
            <Slider
              {...AUTO_REJECT_SLIDERS.months}
              value={s.minMonths}
              disabled={!s.enabled}
              tipFormatter={months}
              getAriaValueText={months}
              aria-label="Minimum stay in months"
              onChange={(minMonths) => setS({ minMonths })}
            />
          </div>
          <div className="options__hint">
            Only offers with an end date are checked; Untermiete without end date stays.
          </div>
        </div>
      </div>
    </Section>
  );
}
