import { useRef, type ReactNode } from "react";
import { ClearFilterButton } from "./ClearFilterButton";
import "./clearable-filter.css";

export function ClearableFilter({
  active,
  label,
  onClear,
  className = "",
  children,
}: {
  active: boolean;
  label: string;
  onClear: () => void;
  className?: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={root}
      className={"clearable-filter " + className + (active ? " has-value" : "")}
    >
      {children}
      {active && (
        <ClearFilterButton
          className="filter-clear"
          label={label}
          onClear={() => {
            onClear();
            root.current
              ?.querySelector<HTMLElement>(
                "input,select,[role=combobox],.filter-button",
              )
              ?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}
