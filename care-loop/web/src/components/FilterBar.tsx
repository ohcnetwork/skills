// FilterBar — driven by the server's facet counts, so a dropdown never offers a value that would
// return nothing.

import { useEffect, useState } from "react";
import type { Facets, RunFilters } from "../api/types";
import { Input, Select } from "./ui/primitives";

export function FilterBar({
  search,
  facets,
  onChange,
}: {
  search: RunFilters;
  facets: Facets | undefined;
  onChange: (next: Partial<RunFilters>) => void;
}) {
  // Synced from the URL rather than driven by it, so typing does not push a history entry per
  // keystroke. Commits after a pause.
  const [q, setQ] = useState(search.q ?? "");
  useEffect(() => setQ(search.q ?? ""), [search.q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if ((search.q ?? "") !== q) onChange({ q: q || undefined, offset: undefined });
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Input
        className="min-w-[200px] flex-1 basis-64"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search task, summary, branch, ticket…"
        spellCheck={false}
        aria-label="Search runs"
      />

      <Facet label="Repo" value={search.repo} options={facets?.repos}
        onChange={(v) => onChange({ repo: v, offset: undefined })} />
      <Facet label="Branch" value={search.branch} options={facets?.branches}
        onChange={(v) => onChange({ branch: v, offset: undefined })} />
      <Facet label="User" value={search.requested_by} options={facets?.users}
        onChange={(v) => onChange({ requested_by: v, offset: undefined })} />
      <Facet label="Step" value={search.step} options={facets?.steps}
        onChange={(v) => onChange({ step: v, offset: undefined })} />

      <Toggle
        label="Active only"
        checked={search.active === true}
        onChange={(on) => onChange({ active: on || undefined, offset: undefined })}
      />
      <Toggle
        label="Show stale"
        checked={search.stale === true}
        onChange={(on) => onChange({ stale: on || undefined, offset: undefined })}
      />

      <Select
        aria-label="Sort by"
        value={search.order ?? "started_at"}
        onChange={(e) => onChange({ order: e.target.value as RunFilters["order"] })}
      >
        <option value="started_at">Started</option>
        <option value="updated_at">Updated</option>
        <option value="cost_usd">Cost</option>
        <option value="duration_ms">Duration</option>
      </Select>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 whitespace-nowrap text-sm">
      <input
        type="checkbox"
        className="size-4 accent-[var(--primary)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function Facet({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: { value: string; count: number }[] | undefined;
  onChange: (v: string | undefined) => void;
}) {
  return (
    <Select aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{label}: any</option>
      {/* A value already in the URL but absent from the facets (excluded by another filter) still
          needs an entry, or the select would show "any" while actually filtering by it. */}
      {value && !options?.some((o) => o.value === value) && <option value={value}>{value}</option>}
      {options?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.value} ({o.count})
        </option>
      ))}
    </Select>
  );
}
