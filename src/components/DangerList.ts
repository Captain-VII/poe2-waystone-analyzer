/** Danger list — Full-mode rendering of `AnalysisResult.dangerHits`
 *  (severity-grouped warnings). Pure string renderer + one delegated
 *  toggle binder, same vanilla pattern as RelicPanel. `DangerHitView.severity`
 *  arrives already collapsed to this 3-tier scale (adapter.ts's job — see
 *  its `UI_SEVERITY` map); this component only groups/renders, it never
 *  reasons about the analyzer's internal reflect/strong/moderate/minor
 *  vocabulary and never feeds anything back into dangerLevel/score. */

import type { DangerHitView } from "../types";

type VisualTier = DangerHitView["severity"];

// Text glyphs, not color emoji — colored per tier in CSS like the rest of
// the panel's iconography (⚠/◆/+ in RelicPanel). "high" has no heading:
// the Insights column's danger-badge already spells out "Very Dangerous"
// right above this list, so a "High" group header directly under it was
// pure duplication (2026-07-12, user request) — medium/low still get
// theirs since nothing else on the card names their severity.
const TIER_META: Record<VisualTier, { heading: string; icon: string }> = {
  high: { heading: "", icon: "⚠" },
  medium: { heading: "Medium", icon: "⚡" },
  low: { heading: "Low", icon: "•" },
};

const TIER_ORDER: VisualTier[] = ["high", "medium", "low"];

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Stable grouping: hits arrive severity-sorted from the adapter, and
 *  filter preserves order, so within-group order is the analyzer's. */
function groupByTier(hits: DangerHitView[]): Record<VisualTier, DangerHitView[]> {
  const groups: Record<VisualTier, DangerHitView[]> = { high: [], medium: [], low: [] };
  for (const hit of hits) groups[hit.severity].push(hit);
  return groups;
}

function row(hit: DangerHitView, tier: VisualTier): string {
  return `<div class="dl-row dl-${tier}"><span class="dl-ic">${
    TIER_META[tier].icon
  }</span><span class="dl-lab">${esc(hit.label)}</span></div>`;
}

/** Renders the grouped danger list as an HTML string, or "" when there are
 *  no hits (the surrounding Insights column renders its own content; an
 *  explicit empty-state line would just add noise). Every hit shows, full
 *  column, no cap (2026-07-22, user request — the old "+N more" toggle
 *  behind a fixed low-severity cap is gone; the bonus row moved to icon
 *  badges the same day specifically to make room for this). Reverted
 *  back to text rows from a brief icon-badge version the same day — user
 *  call: only the Bonus row gets the icon-badge/footer treatment, not
 *  the danger list itself. */
export function renderDangerList(hits: DangerHitView[]): string {
  if (hits.length === 0) return "";

  const groups = groupByTier(hits);
  const parts: string[] = [];

  for (const tier of TIER_ORDER) {
    const group = groups[tier];
    if (group.length === 0) continue;

    if (TIER_META[tier].heading) parts.push(`<div class="dl-group-h dl-${tier}">${TIER_META[tier].heading}</div>`);
    group.forEach((hit) => parts.push(row(hit, tier)));
  }

  return `<div class="danger-list">${parts.join("")}</div>`;
}
