import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
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
        <button
          type="button"
          className="filter-clear"
          title={label}
          aria-label={label}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClear();
            root.current
              ?.querySelector<HTMLElement>(
                "input,select,[role=combobox],.filter-button",
              )
              ?.focus({ preventScroll: true });
          }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
