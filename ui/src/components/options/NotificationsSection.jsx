import { useEffect, useState } from 'react';
import { Button, Input, InputNumber, Slider, Switch, Toast } from '@douyinfe/semi-ui-19';
import Section, { Field } from './Section.jsx';
import { errorMessage, xhrSend } from '../../services/xhr.js';
import { formatRetryAfter } from '../../services/format.js';
import { TierLabel } from '../TierBadge.jsx';
import { LABEL_MARKS, formatHour, slotMarks, summarizeBulk, summarizePriority } from '../../services/schedule.js';
import { notifyBody, notifyToForm, validateNotifyForm } from '../../services/options.js';

/** The switch row of one tier: a tier that is off sends no mail, but its thresholds still define the tier filter. */
function TierHeader({ tier, label, title, enabled, onToggle }) {
  return (
    <div className="options__inline">
      <strong>
        <TierLabel tier={tier}>{title}</TierLabel>
      </strong>
      <Switch checked={enabled} onChange={onToggle} aria-label={`${label} alerts enabled`} />
    </div>
  );
}

function Thresholds({ label, hint, enabled, value, onChange }) {
  return (
    <div className="options__group">
      <div className="options__hint">{hint}</div>
      {enabled ? null : (
        <div className="options__hint">
          Still used for the {label} filter, but no {label} emails are sent.
        </div>
      )}
      <div className={`options__row options__row--compact${enabled ? '' : ' options__muted'}`}>
        <Field label="Score >">
          <InputNumber
            value={value.score ?? ''}
            min={0}
            max={10}
            step={0.5}
            onChange={(v) => onChange({ ...value, score: v === '' ? null : v })}
            aria-label={`${label} score threshold`}
          />
        </Field>
        <Field label="AI score >">
          <InputNumber
            value={value.ai ?? ''}
            min={0}
            max={10}
            step={0.5}
            onChange={(v) => onChange({ ...value, ai: v === '' ? null : v })}
            aria-label={`${label} AI score threshold`}
          />
        </Field>
      </div>
    </div>
  );
}

/**
 * "When may mails go out": a two-handle slider over the 24 h day (tooltip "07:00"). `marks` are the labels under it;
 * for the Good tier they also carry the ticks at every send slot. `summary` is the sentence under the slider.
 */
function WindowSlider({ label, enabled, value, onChange, marks, summary, ticks = false, children }) {
  return (
    <div className={`options__group${enabled ? '' : ' options__muted'}`}>
      <strong>{label}</strong>
      <div className={`options__slider options__slider--hours${ticks ? ' options__slider--ticks' : ''}`}>
        <Slider
          range
          min={0}
          max={24}
          step={1}
          value={value}
          marks={marks}
          tipFormatter={formatHour}
          getAriaValueText={formatHour}
          aria-label={label}
          onChange={onChange}
        />
      </div>
      {children}
      <div className="options__hint" aria-live="polite">
        {summary}
      </div>
    </div>
  );
}

/** Complex rules (several rules, other fields) are shown read-only; the form only writes the simple shape. */
function RulesJson({ label, rules }) {
  return (
    <div className="options__complex">
      <strong>{label} rules</strong>
      <pre className="options__json">{JSON.stringify(rules, null, 2)}</pre>
      <div className="options__hint">These rules are more complex than this form can show. Edit in config.</div>
    </div>
  );
}

export default function NotificationsSection({ settings, defaults, save }) {
  const [form, setForm] = useState(() => notifyToForm(settings.notify));
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => setForm(notifyToForm(settings.notify)), [settings.notify]);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const onSave = async () => {
    const problems = validateNotifyForm(form);
    setErrors(problems);
    if (problems.length > 0) return;
    setSaving(true);
    try {
      await save(notifyBody(form));
      Toast.success('Notification settings saved.');
    } catch (e) {
      setErrors([errorMessage(e, 'Could not save the notification settings.')]);
    }
    setSaving(false);
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const { json } = await xhrSend('POST', '/api/settings/test-mail');
      Toast.success(json.to ? `Test email sent to ${json.to}.` : 'Test email sent.');
    } catch (e) {
      const wait = e?.retryAfterSeconds ? ` Try again in ${formatRetryAfter(e.retryAfterSeconds)}.` : '';
      Toast.error(`${errorMessage(e, 'Could not send the test email.')}${e?.status === 429 ? wait : ''}`);
    }
    setTesting(false);
  };

  const reset = () => setForm(notifyToForm({ ...defaults.notify, email: form.email }));

  return (
    <Section
      title="Notifications"
      intro={
        <p>
          wgg emails you about good offers. <strong>Fantastic</strong> offers are emailed immediately, right after the
          AI assessment of a single offer; <strong>Good</strong> offers are collected into one digest after a fetch has
          been processed. Both only go out in the hours you choose below (server time); what arrives outside waits for
          one morning email. An offer gets the tier whose score is above the number(s) you set (Fantastic wins when both
          match). Leave a field empty to ignore it.
        </p>
      }
      errors={errors}
      saving={saving}
      onSave={onSave}
      onReset={reset}
      extraActions={
        <Button loading={testing} onClick={sendTest}>
          Send test mail
        </Button>
      }
    >
      <label className="options__inline">
        All email alerts
        <Switch checked={form.enabled} onChange={(enabled) => set({ enabled })} aria-label="Alerts enabled" />
      </label>
      <Field label="Notification email" hint="The test mail goes to the saved address, so save first.">
        <Input value={form.email} onChange={(email) => set({ email })} aria-label="Notification email" />
      </Field>
      <TierHeader
        tier="fantastic"
        label="Fantastic"
        title="Fantastic offers — email immediately"
        enabled={form.priorityEnabled}
        onToggle={(priorityEnabled) => set({ priorityEnabled })}
      />
      {form.priority.simple ? (
        <Thresholds
          label="Fantastic"
          enabled={form.priorityEnabled}
          hint="Score > and AI score > below: one email per offer, right after its AI assessment."
          value={form.priority}
          onChange={(priority) => set({ priority })}
        />
      ) : (
        <RulesJson label="Fantastic" rules={settings.notify.priority.rules} />
      )}
      <WindowSlider
        label="Fantastic: send between"
        enabled={form.priorityEnabled}
        value={form.priorityWindow}
        onChange={(priorityWindow) => set({ priorityWindow })}
        marks={LABEL_MARKS}
        summary={summarizePriority({ from: form.priorityWindow[0], to: form.priorityWindow[1] })}
      />
      <TierHeader
        tier="good"
        label="Good"
        title="Good offers — daily/bulk digest"
        enabled={form.bulkEnabled}
        onToggle={(bulkEnabled) => set({ bulkEnabled })}
      />
      {form.bulk.simple ? (
        <Thresholds
          label="Good"
          enabled={form.bulkEnabled}
          hint="Score > and AI score > below: one digest email after a fetch has been processed."
          value={form.bulk}
          onChange={(bulk) => set({ bulk })}
        />
      ) : (
        <RulesJson label="Good" rules={settings.notify.bulk.rules} />
      )}
      <WindowSlider
        label="Good: digests between"
        enabled={form.bulkEnabled}
        value={form.bulkWindow}
        onChange={(bulkWindow) => set({ bulkWindow })}
        marks={slotMarks({ from: form.bulkWindow[0], to: form.bulkWindow[1] }, form.bulkInterval)}
        ticks
        summary={summarizeBulk({ from: form.bulkWindow[0], to: form.bulkWindow[1] }, form.bulkInterval)}
      >
        <strong>Good: one digest every {form.bulkInterval} h</strong>
        <div className="options__slider options__slider--hours">
          <Slider
            min={1}
            max={24}
            step={1}
            value={form.bulkInterval}
            tipFormatter={(v) => `${v} h`}
            getAriaValueText={(v) => `${v} hours`}
            aria-label="Good digest interval in hours"
            onChange={(bulkInterval) => set({ bulkInterval })}
          />
        </div>
      </WindowSlider>
      <Field label="Maximum age in hours" hint="Offers posted longer ago than this are never announced.">
        <InputNumber
          value={form.maxAgeHours}
          min={1}
          max={720}
          onChange={(v) => set({ maxAgeHours: v === '' ? null : v })}
          aria-label="Maximum age in hours"
        />
      </Field>
    </Section>
  );
}
