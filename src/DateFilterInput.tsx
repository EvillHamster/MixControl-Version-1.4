import type { ComponentPropsWithoutRef } from "react";
import { Calendar } from "lucide-react";
import "./date-filter-input.css";

export function DateFilterInput(
  props: Omit<ComponentPropsWithoutRef<"input">, "type">,
) {
  return (
    <div className="date-filter-input">
      <Calendar
        size={16}
        strokeWidth={1.6}
        className="date-filter-icon"
        aria-hidden="true"
      />
      <input {...props} type="date" />
    </div>
  );
}
