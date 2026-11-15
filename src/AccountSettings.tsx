import { PasswordField } from "./PasswordField";
import { useState, type FormEvent } from "react";
import { api } from "./api";
import { useAuth } from "./auth";

export function AccountSettings() {
  const { user } = useAuth();
  return (
    <div className="account-settings">
      <CredentialForm kind="login" login={user.login} />
      <CredentialForm kind="password" login={user.login} />
    </div>
  );
}

function CredentialForm({
  kind,
  login,
}: {
  kind: "login" | "password";
  login: string;
}) {
  const { endSession, refresh } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isLogin = kind === "login";
  const title = isLogin ? "Сменить логин" : "Сменить пароль";
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (!isLogin && next !== confirm) {
      setError("Новые пароли не совпадают");
      return;
    }
    setBusy(true);
    try {
      await api("/auth/credentials", {
        method: "PUT",
        body: JSON.stringify({
          kind,
          currentPassword,
          ...(isLogin ? { login: next } : { password: next }),
        }),
      });
      endSession(
        isLogin
          ? "Логин изменён. Войдите с новым логином."
          : "Пароль изменён. Войдите с новым паролем.",
      );
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof Error && "status" in e && e.status === 401)
        await refresh().catch(() => {});
    } finally {
      setCurrentPassword("");
      setBusy(false);
    }
  }
  return (
    <form
      className="auth-card account-form"
      onSubmit={submit}
      aria-label={title}
    >
      <h2>{title}</h2>
      <p>
        {isLogin ? (
          <>
            Текущий логин: <strong>{login}</strong>
          </>
        ) : (
          "Минимум 4 символа, максимум 128."
        )}
      </p>
      <input
        type="text"
        autoComplete="username"
        value={login}
        readOnly
        hidden
      />
      <PasswordField
        label="Текущий пароль"
        required
        autoComplete="current-password"
        minLength={4}
        maxLength={128}
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
      />
      {isLogin ? (
        <label>
          Новый логин
          <input
            required
            type="text"
            autoComplete="off"
            minLength={3}
            maxLength={64}
            pattern={"[A-Za-z0-9._\\-]{3,64}"}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
      ) : (
        <PasswordField
          label="Новый пароль"
          required
          autoComplete="new-password"
          minLength={4}
          maxLength={128}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      )}
      {!isLogin && (
        <PasswordField
          label="Повторите новый пароль"
          required
          autoComplete="new-password"
          minLength={4}
          maxLength={128}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      )}
      <p>После сохранения потребуется войти снова.</p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <button className="button primary" disabled={busy}>
        {busy ? "Сохраняем…" : title}
      </button>
    </form>
  );
}
