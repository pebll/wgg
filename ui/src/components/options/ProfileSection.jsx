import { useEffect, useState } from 'react';
import { Switch, TextArea, Toast } from '@douyinfe/semi-ui-19';
import Section from './Section.jsx';
import { errorMessage } from '../../services/xhr.js';
import { validateProfile } from '../../services/options.js';

export default function ProfileSection({ settings, defaults, save }) {
  const [profile, setProfile] = useState(settings.llm.profile);
  const [hideIneligible, setHideIneligible] = useState(settings.llm.hideIneligible);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setProfile(settings.llm.profile);
    setHideIneligible(settings.llm.hideIneligible);
  }, [settings.llm]);

  const onSave = async () => {
    const problem = validateProfile(profile);
    setErrors(problem ? [problem] : []);
    if (problem) return;
    setSaving(true);
    try {
      await save({ llm: { profile, hideIneligible } });
      Toast.success('AI profile saved. Your offers are re-assessed automatically; this takes a while.');
    } catch (e) {
      setErrors([errorMessage(e, 'Could not save the AI profile.')]);
    }
    setSaving(false);
  };

  return (
    <Section
      title="AI profile"
      intro={
        <p>
          Describe yourself and what you look for (who moves in, budget, how long you stay, deal-breakers). A local AI
          model reads each offer against this text and gives it an AI score and an eligibility verdict. The pre-filled
          text is an example: replace it with your own. Saving re-assesses your listings automatically.
        </p>
      }
      errors={errors}
      saving={saving}
      onSave={onSave}
      onReset={() => {
        setProfile(defaults.llm.profile);
        setHideIneligible(defaults.llm.hideIneligible);
      }}
    >
      <TextArea value={profile} onChange={setProfile} rows={14} maxCount={4000} aria-label="AI profile text" />
      <label className="options__inline">
        Hide offers the AI finds not eligible
        <Switch checked={hideIneligible} onChange={setHideIneligible} aria-label="Hide ineligible offers" />
      </label>
      <div className="options__hint">
        Hidden offers can be listed with “Show removed automatically” on the Offers tab, and restored there.
      </div>
    </Section>
  );
}
