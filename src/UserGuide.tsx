import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { Role } from "../shared/domain";
import { getUserGuide } from "./user-guide-content";
import "./user-guide.css";

export function UserGuide({
  role,
  onClose,
}: {
  role: Role;
  onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const guide = getUserGuide(role);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop user-guide-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="modal user-guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-guide-title"
        aria-describedby="user-guide-role"
        data-user-guide
      >
        <header className="user-guide-header">
          <h2 id="user-guide-title">Руководство пользователя</h2>
          <p id="user-guide-role">
            {guide.roleName} <span>F1 — справка · Esc — закрыть</span>
          </p>
          <button
            ref={close}
            type="button"
            className="modal-close"
            title="Закрыть руководство"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div
          className="user-guide-body"
          tabIndex={0}
          aria-label="Содержание руководства"
        >
          {guide.sections.map((section) => (
            <section key={section.title}>
              <h3>{section.title}</h3>
              <ol>
                {section.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}
