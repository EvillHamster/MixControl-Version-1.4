import { useId, useState, type ComponentPropsWithoutRef } from "react";
import { Eye, EyeOff } from "lucide-react";

type PasswordFieldProps = Omit<ComponentPropsWithoutRef<"input">, "type"> & {
  label: string;
};

export function PasswordField({
  label,
  id,
  ...inputProps
}: PasswordFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const [visible, setVisible] = useState(false);
  const action = visible ? "Скрыть пароль" : "Показать пароль";

  return (
    <div className="password-field">
      <label htmlFor={fieldId}>{label}</label>
      <div className="password-field-control">
        <input
          {...inputProps}
          id={fieldId}
          type={visible ? "text" : "password"}
        />
        <button
          type="button"
          aria-label={action}
          aria-controls={fieldId}
          title={action}
          className="password-field-toggle"
          onClick={() => setVisible((value) => !value)}
        >
          {visible ? (
            <EyeOff size={17} aria-hidden="true" />
          ) : (
            <Eye size={17} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
