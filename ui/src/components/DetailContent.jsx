import { excerpt, formatCost, formatFact, groupFacts } from '../services/format.js';

const PREVIEW_CHARS = 280;

function FactList({ facts }) {
  return (
    <ul className="detail__factlist">
      {facts.map((fact, i) => (
        <li key={i}>{formatFact(fact)}</li>
      ))}
    </ul>
  );
}

/**
 * What the detail page added (nothing is rendered for parts the page did not have): costs table, WG facts,
 * object facts and the description, which is collapsed behind a "Show full description" toggle.
 */
export default function DetailContent({ details }) {
  if (!details || details.status !== 'fetched') return null;
  const { costs, wgFacts, objectFacts, sections, description } = details;
  const wgGroups = groupFacts(wgFacts);
  const preview = excerpt(sections?.[0]?.text ?? description, PREVIEW_CHARS);

  return (
    <>
      {details.address?.raw && (
        <dl className="detail__facts">
          <dt>Address</dt>
          <dd>{details.address.raw}</dd>
        </dl>
      )}
      {costs?.length > 0 && (
        <>
          <h3 className="detail__heading">Costs</h3>
          <table className="detail__costs">
            <tbody>
              {costs.map((cost, i) => (
                <tr key={i}>
                  <th scope="row">{cost.label}</th>
                  <td>{formatCost(cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {wgGroups.length > 0 && (
        <>
          <h3 className="detail__heading">Flat share</h3>
          {wgGroups.map(({ group, facts }, i) => (
            <div key={i} className="detail__group">
              {group && <h4 className="detail__subheading">{group}</h4>}
              <FactList facts={facts} />
            </div>
          ))}
        </>
      )}
      {objectFacts?.length > 0 && (
        <>
          <h3 className="detail__heading">Property</h3>
          <FactList facts={objectFacts} />
        </>
      )}
      {description && (
        <>
          <h3 className="detail__heading">Description</h3>
          {preview && <p className="detail__excerpt">{preview}</p>}
          <details className="detail__description">
            <summary>Show full description</summary>
            {sections?.length > 0 ? (
              sections.map((section, i) => (
                <section key={i}>
                  {section.heading && <h4 className="detail__subheading">{section.heading}</h4>}
                  <p className="detail__text">{section.text}</p>
                </section>
              ))
            ) : (
              <p className="detail__text">{description}</p>
            )}
          </details>
        </>
      )}
    </>
  );
}
