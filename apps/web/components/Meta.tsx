// Facts in a row, parted by hairlines rather than joined by dots (Hallmark gate 63).
// Empty items are skipped, so callers can pass conditional facts inline.
export function Meta({ items, className }: { items: React.ReactNode[]; className?: string }) {
  const shown = items.filter((x) => x !== null && x !== undefined && x !== false && x !== "");
  if (!shown.length) return null;
  return (
    <span className={className ? `meta ${className}` : "meta"}>
      {shown.map((x, i) => (
        <span key={i}>{x}</span>
      ))}
    </span>
  );
}

// Facts as chips, one colour per kind of fact (country, vertical, size, hours, no website).
export function Facts({ items, className }: { items: [kind: string, text: string | null | undefined | false][]; className?: string }) {
  const shown = items.filter(([, t]) => t);
  if (!shown.length) return null;
  return (
    <span className={className ? `facts ${className}` : "facts"}>
      {shown.map(([kind, t]) => (
        <span key={kind} className={`fact fact-${kind}`}>
          {t}
        </span>
      ))}
    </span>
  );
}
