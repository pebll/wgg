import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Input, Popconfirm, Switch, Toast } from '@douyinfe/semi-ui-19';
import Section, { Field } from './Section.jsx';
import { errorMessage, xhrGet, xhrSend } from '../../services/xhr.js';
import { queryFetchNotice, validateQueryForm } from '../../services/options.js';

/** Starts a fetch right away so a new or changed query shows its offers soon; the 409/429 guards are only information. */
async function fetchSoon() {
  try {
    await xhrSend('POST', '/api/fetch');
    Toast.success('Fetching your query now. New offers appear in the Offers tab in a minute.');
  } catch (e) {
    const { level, message } = queryFetchNotice(e);
    (level === 'info' ? Toast.info : Toast.warning)(message);
  }
}

function Explainer() {
  return (
    <ol className="options__steps">
      <li>
        Open <strong>wg-gesucht.de</strong>, choose your city and <strong>“WG-Zimmer”</strong>, and set your filters
        (max rent, districts, radius…).
      </li>
      <li>
        Click <strong>Search</strong>.
      </li>
      <li>
        Copy the full address from the browser bar of the results page and paste it here. Only wg-gesucht.de result
        pages work; results are sorted newest-first automatically.
      </li>
    </ol>
  );
}

function QueryForm({ initial, submitLabel, onSubmit, onCancel }) {
  const [name, setName] = useState(initial.name);
  const [url, setUrl] = useState(initial.url);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const problem = validateQueryForm({ url, name });
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim(), url: url.trim() });
    } catch (e) {
      setError(errorMessage(e, 'Could not save the query.'));
      setBusy(false);
    }
    return undefined;
  };

  return (
    <div className="options__form">
      <Field label="Name (optional)">
        <Input value={name} onChange={setName} maxLength={100} placeholder="e.g. Munich" aria-label="Query name" />
      </Field>
      <Field label="WG-Gesucht address">
        <Input
          value={url}
          onChange={setUrl}
          placeholder="https://www.wg-gesucht.de/wg-zimmer-in-…"
          aria-label="WG-Gesucht search address"
        />
      </Field>
      {error && <Banner type="danger" closeIcon={null} description={error} />}
      <div className="options__actions">
        <Button theme="solid" type="primary" loading={busy} onClick={submit}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button theme="borderless" type="tertiary" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

export default function QueriesSection() {
  const [data, setData] = useState({ items: [], max: 1, loaded: false, error: null });
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      const { json } = await xhrGet('/api/queries');
      setData({ items: json.items ?? [], max: json.max ?? 1, loaded: true, error: null });
    } catch (e) {
      setData((d) => ({ ...d, loaded: true, error: errorMessage(e, 'Could not load your queries.') }));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const add = async (values) => {
    await xhrSend('POST', '/api/queries', values);
    await load();
    fetchSoon();
  };
  const update = async (item, values, { fetch = true } = {}) => {
    await xhrSend('PUT', `/api/queries/${item.id}`, values);
    setEditing(null);
    await load();
    if (fetch && (values.enabled ?? item.enabled)) fetchSoon();
  };
  const toggle = async (item, enabled) => {
    try {
      await update(item, { enabled });
    } catch (e) {
      Toast.error(errorMessage(e, 'Could not change the query.'));
    }
  };
  const remove = async (item) => {
    try {
      await xhrSend('DELETE', `/api/queries/${item.id}`);
      await load();
    } catch (e) {
      Toast.error(errorMessage(e, 'Could not delete the query.'));
    }
  };

  const full = data.items.length >= data.max;
  return (
    <Section
      title="Queries"
      intro={
        <>
          <p>
            Your searches on WG-Gesucht. wgg checks them regularly and scores what it finds.{' '}
            <strong>
              {data.items.length} of {data.max}
            </strong>{' '}
            {data.max === 1 ? 'query' : 'queries'} used (the limit keeps the load on WG-Gesucht low).
          </p>
          <Explainer />
        </>
      }
    >
      {data.error && <Banner type="danger" closeIcon={null} description={data.error} />}
      {data.items.map((item) =>
        editing === item.id ? (
          <QueryForm
            key={item.id}
            initial={item}
            submitLabel="Save query"
            onSubmit={(values) => update(item, values)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div className="options__query" key={item.id}>
            <div className="options__query-main">
              <strong>{item.name || 'Unnamed query'}</strong>
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="options__url">
                {item.url}
              </a>
            </div>
            <label className="options__inline">
              Enabled
              <Switch checked={item.enabled} onChange={(v) => toggle(item, v)} aria-label="Query enabled" />
            </label>
            <Button size="small" onClick={() => setEditing(item.id)}>
              Edit
            </Button>
            <Popconfirm
              title="Delete this query?"
              content="Its offers disappear from your list."
              onConfirm={() => remove(item)}
            >
              <Button size="small" type="danger" theme="borderless">
                Delete
              </Button>
            </Popconfirm>
          </div>
        ),
      )}
      {data.loaded && data.items.length === 0 && <div className="options__hint">You have no query yet.</div>}
      {!full && data.loaded && (
        <QueryForm key={data.items.length} initial={{ name: '', url: '' }} submitLabel="Add query" onSubmit={add} />
      )}
      {full && (
        <div className="options__hint">
          You have reached the limit of {data.max} {data.max === 1 ? 'query' : 'queries'}. Edit or delete one to change
          it.
        </div>
      )}
    </Section>
  );
}
