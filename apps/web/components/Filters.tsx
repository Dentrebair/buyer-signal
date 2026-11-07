"use client";
import { useRouter, useSearchParams } from "next/navigation";

export interface FilterOption {
  value: string;
  label: string;
}

// One select per filter; changing it updates the URL (bookmarkable view, §10.1).
export function FilterSelect({ name, label, options }: { name: string; label: string; options: FilterOption[] }) {
  const router = useRouter();
  const sp = useSearchParams();
  const onChange = (value: string) => {
    const p = new URLSearchParams(sp.toString());
    if (value) p.set(name, value);
    else p.delete(name);
    p.delete("id"); // the open company may not match the new filter
    router.push(`/dashboard?${p}`);
  };
  return (
    <label className="field">
      {label}
      <select value={sp.get(name) ?? ""} onChange={(e) => onChange(e.target.value)} className={sp.get(name) ? "is-set" : undefined}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
