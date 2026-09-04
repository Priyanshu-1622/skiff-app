import type { ReactNode } from "react";
import * as I from "@/components/icons";

/**
 * Toolbar — the search + actions row at the top of the main column.
 *
 * In the Instrument Panel design there is no bar spanning the window; the
 * brand sits in the sidebar and this row lives inside the content column,
 * aligned to it. Screens pass their own right-hand actions (view toggle, Add
 * host, filters) as children so the row stays one consistent height and
 * baseline everywhere.
 */

export interface ToolbarProps {
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  placeholder?: string;
  hideSearch?: boolean;
  /** Right-aligned controls for the current screen. */
  actions?: ReactNode;
}

export function Toolbar({
  searchValue = "",
  onSearchChange,
  placeholder = "Search hosts, IPs, tags…",
  hideSearch,
  actions,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      {hideSearch ? (
        <div />
      ) : (
        <label className="toolbar__search">
          <I.Search size={13} />
          <input
            type="text"
            placeholder={placeholder}
            value={searchValue}
            onChange={(e) => onSearchChange?.(e.target.value)}
          />
        </label>
      )}
      <div className="toolbar__actions">{actions}</div>
    </div>
  );
}
