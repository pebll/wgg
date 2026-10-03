import { useState } from 'react';
import { Button, Radio, RadioGroup, Slider, Tag, TextArea } from '@douyinfe/semi-ui-19';
import { IconArrowDown, IconMoon, IconSun } from '@douyinfe/semi-icons';
import AiAssessment from './AiAssessment.jsx';
import BarChart from './BarChart.jsx';
import BrandLogo from './BrandLogo.jsx';
import ListingCard from './ListingCard.jsx';
import ScoreBreakdown from './ScoreBreakdown.jsx';
import { TierIcon, TierLabel } from './TierBadge.jsx';
import WeightsPie from './options/WeightsPie.jsx';
import {
  DEMO_PARAMETERS,
  DEMO_PHOTOS,
  DEMO_TARGET,
  demoEmail,
  demoListings,
  demoStats,
  demoWeights,
} from '../services/demo.js';
import { formatRent } from '../services/format.js';
import '../About.less';

const CONTACT = 'leo@brucker.fr';
const MAILTO = `mailto:${CONTACT}?subject=${encodeURIComponent('WG Gefunden! account request')}`;
const BADGE_THRESHOLD = 0.3;
const noop = () => {};

/** Scrolls to a section; instant when the visitor prefers reduced motion. */
function scrollToId(id) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const el = document.getElementById(id);
  el?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  el?.focus({ preventScroll: true });
}

/** A feature: text on one side, a live example on the other (stacked on a phone). */
function Feature({ id, title, intro, points, children }) {
  return (
    <section className="about__feature" aria-labelledby={`${id}-title`}>
      <div className="about__text">
        <h2 id={`${id}-title`}>{title}</h2>
        <p>{intro}</p>
        {points && (
          <ul>
            {points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="about__demo">{children}</div>
    </section>
  );
}

/** Frame of an example: always labelled, so nobody takes the made-up data for real offers. */
function Example({ children, className = '' }) {
  return (
    <figure className={`about__example ${className}`}>
      <figcaption>
        <Tag size="small" color="grey">
          Example
        </Tag>
        <span>made-up data</span>
      </figcaption>
      {children}
    </figure>
  );
}

function MailMock({ kind }) {
  const mail = demoEmail(kind);
  return (
    <div className={`about__mail about__mail--${kind}`}>
      <div className="about__mail-subject">{mail.subject}</div>
      <div className="about__mail-body">
        <strong className="about__mail-head">{mail.headline}</strong>
        {mail.items.map((m) => (
          <div key={m.title} className="about__mail-item">
            <span>{m.title}</span>
            <span>
              {formatRent(m.rent)} · {m.size} m² · {m.district} · score {m.score} · AI {m.ai}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsMock() {
  const [weights, setWeights] = useState(demoWeights);
  const [rent, setRent] = useState([450, 700]);
  return (
    <div className="about__settings">
      <label className="about__field">
        WG-Gesucht search
        <input
          className="about__input"
          readOnly
          value="WG rooms in your city, up to 700 €, from 1 November"
          aria-label="Example search"
        />
      </label>
      <label className="about__field">
        AI profile
        <TextArea
          readonly
          rows={3}
          value="Two of us, starting a master's. Budget up to 700 €, staying 1-2 years. No fraternities, no party flats."
          aria-label="Example AI profile"
        />
      </label>
      <div className="about__field">
        <span>
          Rent: {rent[0]}-{rent[1]} €
        </span>
        <Slider range min={200} max={1500} step={10} value={rent} onChange={setRent} aria-label="Rent range" />
      </div>
      <div className="about__field">
        Weights
        <div className="about__weights">
          {DEMO_PARAMETERS.map(([key, label]) => (
            <label key={key} className="about__weight">
              <span>{label}</span>
              <Slider
                min={0}
                max={5}
                step={0.5}
                value={weights[key]}
                onChange={(v) => setWeights((w) => ({ ...w, [key]: v }))}
                aria-label={`Weight ${label}`}
              />
            </label>
          ))}
        </div>
        <WeightsPie weights={weights} parameters={DEMO_PARAMETERS} />
      </div>
    </div>
  );
}

/**
 * The public presentation page: what WG Gefunden! does, with live components fed by made-up example data.
 * It needs no session and makes no API call. `onLogin` opens the login form.
 */
export default function About({ onLogin, theme, onToggleTheme, loggedIn = false, onBack }) {
  const [now] = useState(Date.now);
  const { scoring, verbindung, flat } = demoListings(now);
  const stats = demoStats();
  const [mode, setMode] = useState('fantastic');

  const charts = [
    ['score', 'Score', 'Overall score (1–10)', 'score', { unscored: 0 }],
    ['ai', 'AI score', 'AI fit score (1–10)', 'score', { unassessed: stats.ai.unassessed }],
    ['rent', 'Rent', 'Rent in € (50 € steps)', 'rent', {}],
    ['distance', 'Distance', 'Distance to the target in km', 'distance', { unknown: stats.distance.unknown }],
  ];

  return (
    <div className="about">
      <header className="about__bar">
        <BrandLogo />
        <div className="about__bar-actions">
          <Button
            theme="borderless"
            icon={theme === 'dark' ? <IconSun /> : <IconMoon />}
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          />
          {loggedIn ? (
            <Button theme="solid" type="primary" onClick={onBack}>
              Back to my offers
            </Button>
          ) : (
            <Button theme="solid" type="primary" onClick={onLogin}>
              Log in
            </Button>
          )}
        </div>
      </header>

      <main>
        <section className="about__hero" aria-labelledby="about-title">
          <img
            className="about__hero-photo"
            src={DEMO_PHOTOS.hero}
            alt="Colourful old-town buildings along a quiet European street (generic stock photo)"
            width="1200"
            height="800"
            fetchPriority="high"
          />
          <div className="about__hero-body">
            <h1 id="about-title">
              <span className="about__sr">WG Gefunden! </span>
              <span aria-hidden="true">
                <span className="brand__wg">WG</span> Gefunden<span className="brand__bang">!</span>
              </span>
            </h1>
            <p className="about__tagline">
              Your private WG-Gesucht scout for any city. It watches new offers, has an AI read each ad and only emails
              you about the good ones.
            </p>
            <div className="about__cta">
              {!loggedIn && (
                <Button theme="solid" type="primary" size="large" onClick={onLogin}>
                  Log in
                </Button>
              )}
              <Button
                theme="light"
                size="large"
                icon={<IconArrowDown />}
                iconPosition="right"
                onClick={() => scrollToId('how')}
              >
                How it works
              </Button>
            </div>
          </div>
        </section>

        <div id="how" tabIndex={-1} className="about__anchor" />

        <Feature
          id="scoring"
          title="Smart scoring"
          intro="Every new offer is scored from 1 to 10 on what matters to you: rent, distance, freshness and how long you can stay. Stars are the numbers, circles are the AI's opinion."
          points={[
            'Open the details to see why an offer got its score',
            'Distance is measured to your own target (university, office, anywhere)',
            'New offers wear a NEW tag for their first hour',
          ]}
        >
          <Example>
            <div className="about__tile">
              <div inert>
                <ListingCard
                  item={scoring}
                  sort="overall"
                  selected={false}
                  onSelect={noop}
                  onDismiss={noop}
                  onMessaged={noop}
                  onRestore={noop}
                  badgeThreshold={BADGE_THRESHOLD}
                  targetName={DEMO_TARGET}
                />
              </div>
            </div>
            <ScoreBreakdown evaluation={scoring.evaluation} geoPrecision={scoring.geoPrecision} llm={scoring.llm} />
          </Example>
        </Feature>

        <Feature
          id="ai"
          title="An AI reads every ad"
          intro="A language model reads the full ad against your profile: a fit score, a summary, green and red flags. Open 'Why not 10?' to see exactly which points were deducted, and why."
          points={[
            'Spots ads that rule you out, so you do not waste a message',
            'Runs on a model you control, only the ad text is sent',
            'Re-reads the offers when you change your profile',
          ]}
        >
          <Example>
            <div className="about__panel">
              <AiAssessment llm={scoring.llm} badgeThreshold={BADGE_THRESHOLD} now={now} />
            </div>
            <div className="about__panel about__panel--small">
              <div className="ai__ineligible">Not eligible: women only</div>
              <span className="about__note">Ads that exclude you are flagged, and can be hidden automatically.</span>
            </div>
          </Example>
        </Feature>

        <Feature
          id="verbindung"
          title="Auto-reject: Verbindungen and short-term rentals"
          intro="Cheap rooms in fraternity houses (Studentenverbindungen) are rarely labelled as such. A word list catches the obvious ones, the AI estimates the probability and quotes the giveaway phrases. Above your threshold the ad leaves your list."
          points={[
            'Short-term and temporary rentals are filtered out too',
            'You can still show removed offers and restore them',
          ]}
        >
          <Example>
            <div className="about__tile">
              <div inert>
                <ListingCard
                  item={verbindung}
                  sort="overall"
                  selected={false}
                  onSelect={noop}
                  onDismiss={noop}
                  onMessaged={noop}
                  onRestore={noop}
                  badgeThreshold={BADGE_THRESHOLD}
                  targetName={DEMO_TARGET}
                />
              </div>
            </div>
            <div className="about__panel">
              <AiAssessment llm={verbindung.llm} badgeThreshold={BADGE_THRESHOLD} now={now} />
            </div>
          </Example>
        </Feature>

        <Feature
          id="flat"
          title="Know the flat before you write"
          intro="Cards show who lives there (how many flatmates, and how many women and men), the distance to your target and the tier the offer reached."
        >
          <Example>
            <div className="about__tile">
              <div inert>
                <ListingCard
                  item={flat}
                  sort="overall"
                  selected={false}
                  onSelect={noop}
                  onDismiss={noop}
                  onMessaged={noop}
                  onRestore={noop}
                  badgeThreshold={BADGE_THRESHOLD}
                  targetName={DEMO_TARGET}
                />
              </div>
            </div>
          </Example>
        </Feature>

        <Feature
          id="distribution"
          title="Distribution and filters"
          intro="Four small charts show how the current offers spread over score, AI score, rent and distance. Click a bar to filter to that range, or jump straight to your Fantastic or Good offers."
        >
          <Example>
            <div className="about__charts">
              {charts.map(([key, title, caption, kind, extras]) => (
                <BarChart
                  key={key}
                  title={title}
                  caption={caption}
                  kind={kind}
                  tone={key}
                  bins={stats[key].bins}
                  extras={extras}
                />
              ))}
            </div>
            <div className="about__filter" role="group" aria-label="Filter">
              Filter:
              <RadioGroup type="button" value={mode} onChange={(e) => setMode(e.target.value)}>
                <Radio value="all">All</Radio>
                <Radio value="fantastic">
                  <TierLabel tier="fantastic" />
                </Radio>
                <Radio value="good">
                  <TierLabel tier="good" />
                </Radio>
                <Radio value="custom">Custom</Radio>
              </RadioGroup>
            </div>
          </Example>
        </Feature>

        <Feature
          id="alerts"
          title="Alerts that respect your inbox"
          intro="Each tier has its own email switch and its own send window. Mail that is due outside the window waits and arrives as one morning email."
        >
          <Example>
            <div className="about__alerts">
              <div>
                <h3>
                  <TierIcon tier="fantastic" size={16} /> Fantastic
                </h3>
                <p>One email as soon as the AI has read the ad, inside your send window.</p>
                <MailMock kind="fantastic" />
              </div>
              <div>
                <h3>
                  <TierIcon tier="good" size={16} /> Good
                </h3>
                <p>Collected into one digest per round, inside its window.</p>
                <MailMock kind="good" />
              </div>
            </div>
          </Example>
        </Feature>

        <Feature
          id="settings"
          title="Your settings"
          intro="Everything is yours: your search, a few sentences about you for the AI, your budget and how much each factor counts. Try the sliders."
        >
          <Example>
            <SettingsMock />
          </Example>
        </Feature>

        <section className="about__polite" aria-labelledby="polite-title">
          <h2 id="polite-title">Polite by design</h2>
          <ul>
            <li>One search round every 30 minutes, give or take a random jitter.</li>
            <li>One detail page per minute at most; a manual fetch needs a 10-minute gap.</li>
            <li>Backs off when a bot wall shows up; it never tries to get around one.</li>
            <li>One search per user, so the load stays small.</li>
            <li>Accounts are by invitation only, which keeps it a small private tool.</li>
          </ul>
        </section>

        {!loggedIn && (
          <section className="about__join" aria-labelledby="join-title">
            <h2 id="join-title">Interested?</h2>
            <p>
              Request an account at <a href={MAILTO}>{CONTACT}</a>
            </p>
            <div className="about__cta">
              <Button theme="solid" type="primary" size="large" onClick={onLogin}>
                Log in
              </Button>
            </div>
          </section>
        )}
      </main>

      <footer className="about__footer">
        <p>© 2026 Léo Brucker · MIT licensed · private, non-commercial project</p>
        <p>Not affiliated with WG-Gesucht.</p>
      </footer>
    </div>
  );
}
