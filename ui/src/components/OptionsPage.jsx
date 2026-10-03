import { Banner, Spin } from '@douyinfe/semi-ui-19';
import QueriesSection from './options/QueriesSection.jsx';
import AutoRejectSection from './options/AutoRejectSection.jsx';
import NotificationsSection from './options/NotificationsSection.jsx';
import ProfileSection from './options/ProfileSection.jsx';
import ScoringSection from './options/ScoringSection.jsx';
import { useSettings } from '../hooks/useSettings.js';

/** The Options tab: queries, notifications, AI profile, auto-reject and scoring of the logged-in user. */
export default function OptionsPage({ onTargetName }) {
  const { settings, defaults, error, save: saveSettings } = useSettings();
  // The dashboard names the scoring target in every distance: tell it when a save changed the name.
  const save = async (partial) => {
    const saved = await saveSettings(partial);
    onTargetName?.(saved?.scoring?.target?.name);
    return saved;
  };
  return (
    <div className="options">
      <QueriesSection />
      {error && <Banner type="danger" closeIcon={null} description={error} />}
      {!settings && !error && <Spin />}
      {settings && (
        <>
          <NotificationsSection settings={settings} defaults={defaults} save={save} />
          <ProfileSection settings={settings} defaults={defaults} save={save} />
          <AutoRejectSection settings={settings} defaults={defaults} save={save} />
          <ScoringSection settings={settings} defaults={defaults} save={save} />
        </>
      )}
    </div>
  );
}
