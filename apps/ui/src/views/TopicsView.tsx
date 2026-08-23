import { useEffect, useState } from "react";
import { api, type AppState, type TopicGroup, type TopicItems } from "../api.js";
import { BusyButton, MarkButtons, navTo } from "../ui.js";

// LLM-derived topic groups over the saved library. The scheme is proposed by
// the taxonomy reactor; regenerating re-derives it from scratch, while
// "classify new" only assigns saved items the current scheme hasn't seen.

export function TopicsView({ slug, state }: { slug: string | null; state: AppState | null }) {
  return slug === null ? <TopicIndex state={state} /> : <TopicDetail slug={slug} />;
}

function TopicIndex({ state }: { state: AppState | null }) {
  const [groups, setGroups] = useState<TopicGroup[] | null>(null);
  const [tick, setTick] = useState(0);

  const classifying = state?.jobs.some((j) => j.process === "reactor:taxonomy") ?? false;

  useEffect(() => {
    void api.topics().then((r) => setGroups(r.groups));
  }, [tick]);

  // While a classification job runs, poll for its results landing.
  useEffect(() => {
    if (!classifying) {
      return;
    }
    const timer = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(timer);
  }, [classifying]);

  return (
    <div className="entity-page">
      <div className="entity-head">
        <span className="entity-kind">saved library</span>
        <h1>topics</h1>
      </div>
      <div className="run-row">
        <BusyButton className="primary" onClick={() => api.classify(false).then(() => setTick((t) => t + 1))}>
          Classify new items
        </BusyButton>
        {classifying && <span className="working">classifying…</span>}
      </div>
      {groups === null && <div className="empty">loading…</div>}
      {groups !== null && groups.length === 0 && (
        <div className="empty">
          No scheme yet — "Classify new items" has a model read every saved title, invent
          topic groups for this collection, and assign each item.
        </div>
      )}
      {groups !== null && (
        <section className="link-group">
          {groups.map((g) => (
            <a key={g.slug} className="link-row" href={`#/topics/${encodeURIComponent(g.slug)}`}>
              <span className="link-name">{g.name}</span>
              <span className="topic-desc">{g.description}</span>
              <span className="link-provenance">{g.items}</span>
            </a>
          ))}
        </section>
      )}
    </div>
  );
}

function TopicDetail({ slug }: { slug: string }) {
  const [topic, setTopic] = useState<TopicItems | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void api.topicItems(slug).then(setTopic);
  }, [slug, tick]);

  if (topic === null) {
    return <div className="empty">loading…</div>;
  }
  return (
    <div className="entity-page">
      <div className="entity-head">
        <span className="entity-kind">
          <a className="crumb" href="#/topics">topics</a>
        </span>
        <h1>{topic.name}</h1>
      </div>
      <p className="run-fact">{topic.description}</p>
      <section className="link-group">
        {topic.items.map((item) => (
          <div key={item.entityId} className="link-row marked-row">
            <span className="link-kind">{item.kind}</span>
            <a className="link-name" href={`#/entity/${item.entityId}`}>
              {item.title ?? item.entityId}
            </a>
            <span className="link-provenance">{item.confidence.toFixed(2)}</span>
            <MarkButtons
              entityId={item.entityId}
              mark={item.mark}
              onChanged={() => setTick((t) => t + 1)}
            />
          </div>
        ))}
      </section>
      {topic.items.length === 0 && <div className="empty">Nothing assigned to this group yet.</div>}
    </div>
  );
}
