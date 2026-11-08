"use client";
// Tabs (WAI-ARIA tabs pattern): arrow keys, Home and End move between tabs; the first tab is open
// by default. Panels are rendered on the server and passed in. A link to "#some-id" inside the
// tabs (or a page opened with that hash) opens the tab holding that element and scrolls to it.
import { useCallback, useEffect, useRef, useState } from "react";

export interface Tab {
  id: string;
  label: string;
  count?: number;
  content: React.ReactNode;
}

export function Tabs({ tabs, label }: { tabs: Tab[]; label: string }) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (i: number) => {
    const next = (i + tabs.length) % tabs.length;
    setActive(next);
    refs.current[next]?.focus();
  };
  // `tabs` is a new array on every server refresh: read it through a ref so the hash is applied
  // on load and on hash changes only, not every time the page refreshes itself.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const reveal = useCallback((hash: string) => {
    const el = hash.length > 1 ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    // Tabs can nest: find the panel that belongs to this set, however deep the target sits.
    let i = -1;
    for (let panel = el?.closest('[role="tabpanel"]'); panel && i < 0; panel = panel.parentElement?.closest('[role="tabpanel"]')) {
      const id = panel.id;
      i = tabsRef.current.findIndex((t) => `panel-${t.id}` === id);
    }
    if (!el || i < 0) return false;
    setActive(i);
    setTimeout(() => el.scrollIntoView({ block: "start" }), 0); // after the panel is shown
    return true;
  }, []);
  useEffect(() => {
    reveal(window.location.hash);
    const on = () => reveal(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, [reveal]);
  // A second click on the same "#id" link fires no hashchange, so links are handled here.
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest('a[href^="#"]');
    const href = a?.getAttribute("href");
    if (!href || !reveal(href)) return;
    e.preventDefault();
    history.replaceState(null, "", href);
    // Nested tab sets open their own level too: they all listen for hashchange.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    move(to);
  };
  return (
    <div className="tabs" onClick={onClick}>
      <div role="tablist" aria-label={label} className="tab-list">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={i === active}
            aria-controls={`panel-${t.id}`}
            tabIndex={i === active ? 0 : -1}
            className="tab"
            onClick={() => setActive(i)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
            {t.count !== undefined && <span className="tab-count num">{t.count}</span>}
          </button>
        ))}
      </div>
      {tabs.map((t, i) => (
        <div key={t.id} role="tabpanel" id={`panel-${t.id}`} aria-labelledby={`tab-${t.id}`} hidden={i !== active} tabIndex={0} className="tab-panel">
          {t.content}
        </div>
      ))}
    </div>
  );
}
