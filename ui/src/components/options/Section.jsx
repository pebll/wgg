import { Banner, Button } from '@douyinfe/semi-ui-19';

/**
 * A card of the Options tab: title, short explanation, the fields, validation messages and Save / Reset buttons.
 * `onReset` fills the fields with the defaults (nothing is stored until Save).
 */
export default function Section({ id, title, intro, children, errors = [], saving, onSave, onReset, extraActions }) {
  return (
    <section id={id} className="options__section" aria-label={title}>
      <h3 className="options__title">{title}</h3>
      {intro && <div className="options__intro">{intro}</div>}
      {children}
      {errors.length > 0 && (
        <Banner
          type="danger"
          closeIcon={null}
          className="options__errors"
          description={errors.length === 1 ? errors[0] : errors.map((e) => <div key={e}>{e}</div>)}
        />
      )}
      {(onSave || onReset || extraActions) && (
        <div className="options__actions">
          {onSave && (
            <Button theme="solid" type="primary" loading={saving} onClick={onSave}>
              Save
            </Button>
          )}
          {onReset && (
            <Button theme="borderless" type="tertiary" onClick={onReset}>
              Reset to default
            </Button>
          )}
          {extraActions}
        </div>
      )}
    </section>
  );
}

/** Label above a control (the control keeps its own aria-label). */
export function Field({ label, hint, children }) {
  return (
    <label className="options__field">
      <span className="options__label">{label}</span>
      {children}
      {hint && <span className="options__hint">{hint}</span>}
    </label>
  );
}
