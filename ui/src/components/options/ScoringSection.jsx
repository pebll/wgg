import { useEffect, useState } from 'react';
import { Input, Slider, TagInput, Toast } from '@douyinfe/semi-ui-19';
import Section, { Field } from './Section.jsx';
import WeightsPie from './WeightsPie.jsx';
import { errorMessage } from '../../services/xhr.js';
import {
  SLIDER_SPECS,
  WEIGHT_SLIDER,
  describeRange,
  rangeToSlider,
  scoringBody,
  scoringToForm,
  sliderToRange,
  validateScoringForm,
} from '../../services/options.js';

/** One two-handle slider for a best/worst (or minimum/wanted) pair, with the current values in words next to it. */
function RangeSlider({ label, hint, specKey, value, onChange }) {
  const spec = SLIDER_SPECS[specKey];
  const [from, to] = rangeToSlider(value, spec);
  return (
    <div className="options__group">
      <strong>{label}</strong>
      {hint && <div className="options__hint">{hint}</div>}
      <div className="options__slider">
        <Slider
          range
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={[from, to]}
          tipFormatter={(v) => `${v} ${spec.unit}`}
          getAriaValueText={(v) => `${v} ${spec.unit}`}
          aria-label={label}
          onChange={(pos) => onChange({ ...value, ...sliderToRange(pos, spec) })}
        />
        <div className="options__value" aria-live="polite">
          {describeRange(value, spec)}
        </div>
      </div>
    </div>
  );
}

const WEIGHTS = [
  ['rent', 'Rent'],
  ['distance', 'Distance'],
  ['recency', 'Recency'],
  ['size', 'Size'],
  ['stayLength', 'Stay length'],
];

export default function ScoringSection({ settings, defaults, save }) {
  const [form, setForm] = useState(() => scoringToForm(settings.scoring));
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [located, setLocated] = useState(settings.scoring.target);
  useEffect(() => {
    setForm(scoringToForm(settings.scoring));
    setLocated(settings.scoring.target);
  }, [settings.scoring]);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const onSave = async () => {
    const problems = validateScoringForm(form);
    setErrors(problems);
    if (problems.length > 0) return;
    setSaving(true);
    try {
      await save(scoringBody(form));
      Toast.success('Scoring saved. Your offers are scored again.');
    } catch (e) {
      // 422: the address was not found; 429: too many address lookups; 400: a value the server refuses.
      setErrors([errorMessage(e, 'Could not save the scoring settings.')]);
    }
    setSaving(false);
  };

  const hasPlace = Number.isFinite(located?.lat) && Number.isFinite(located?.lng);
  return (
    <Section
      id="options-scoring"
      title="Scoring"
      intro={
        <p>
          How each offer gets its score (1–10). “Best” earns the full points, “worst” none; values in between are
          scaled. The weights say how much each factor counts. Saving scores your offers again.
        </p>
      }
      errors={errors}
      saving={saving}
      onSave={onSave}
      onReset={() => setForm(scoringToForm({ ...defaults.scoring, target: settings.scoring.target }))}
    >
      <div className="options__row">
        <Field label="Target name (optional)">
          <Input
            value={form.target.name}
            onChange={(name) => set({ target: { ...form.target, name } })}
            aria-label="Target name"
          />
        </Field>
        <Field
          label="Target address"
          hint={
            hasPlace
              ? `Located at ${located.lat.toFixed(4)}, ${located.lng.toFixed(4)}. A changed address is looked up when you save.`
              : 'Distances are measured to this place. It is looked up when you save.'
          }
        >
          <Input
            value={form.target.address}
            onChange={(address) => set({ target: { ...form.target, address } })}
            placeholder="Street and city, or a landmark"
            aria-label="Target address"
          />
        </Field>
      </div>
      <RangeSlider
        label="Rent (€)"
        specKey="rent"
        value={form.rent}
        onChange={(rent) => set({ rent })}
        hint="Full points at “best”, none at “worst”. There is no cap: limit the rent in your WG-Gesucht search."
      />
      <RangeSlider label="Size (m²)" specKey="sizeM2" value={form.sizeM2} onChange={(sizeM2) => set({ sizeM2 })} />
      <RangeSlider
        label="Distance (km)"
        specKey="distanceKm"
        value={form.distanceKm}
        onChange={(distanceKm) => set({ distanceKm })}
      />
      <RangeSlider
        label="Recency (hours since posted)"
        specKey="recencyHours"
        value={form.recencyHours}
        onChange={(recencyHours) => set({ recencyHours })}
      />
      <RangeSlider
        label="Stay length (days)"
        specKey="stayLength"
        value={form.stayLength}
        onChange={(stayLength) => set({ stayLength })}
        hint="Only for time-limited offers: full score from the wanted stay, lowest below the shortest acceptable stay. Open-ended offers score full."
      />
      <div className="options__group">
        <strong>Weights</strong>
        <div className="options__hint">0 ignores a factor. At least one weight must be above 0.</div>
        <div className="options__weights-layout">
          <div className="options__weights">
            {WEIGHTS.map(([key, text]) => (
              <div key={key} className="options__slider options__slider--weight">
                <span className="options__label">{text}</span>
                <Slider
                  min={WEIGHT_SLIDER.min}
                  max={WEIGHT_SLIDER.max}
                  step={WEIGHT_SLIDER.step}
                  value={form.weights[key] ?? 0}
                  tipFormatter={(v) => String(v)}
                  aria-label={`Weight ${text}`}
                  onChange={(v) => set({ weights: { ...form.weights, [key]: v } })}
                />
                <span className="options__value">{form.weights[key] ?? 0}</span>
              </div>
            ))}
          </div>
          <WeightsPie weights={form.weights} parameters={WEIGHTS} />
        </div>
      </div>
      <Field
        label="Exclusion keywords"
        hint="Offers mentioning one of these words are hidden automatically. Press Enter to add."
      >
        <TagInput
          value={form.keywords}
          onChange={(keywords) => set({ keywords })}
          allowDuplicates={false}
          aria-label="Exclusion keywords"
        />
      </Field>
    </Section>
  );
}
