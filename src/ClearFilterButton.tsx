import { X } from "lucide-react";
import "./clear-filter-button.css";

export function ClearFilterButton({
  label,
  onClear,
  className = "",
}: {
  label: string;
  onClear: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={"clear-filter-button " + className}
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const input = e.currentTarget
          .closest(".search")
          ?.querySelector<HTMLInputElement>("input");
        onClear();
        input?.focus({ preventScroll: true });
      }}
    >
      <X size={13} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
