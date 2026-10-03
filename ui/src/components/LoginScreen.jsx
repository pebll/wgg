import { useState } from 'react';
import { Banner, Button, Input } from '@douyinfe/semi-ui-19';
import BrandLogo from './BrandLogo.jsx';
import { loginMessage } from '../services/auth.js';

/**
 * Username + password form. `onLogin(username, password)` rejects with the request error when the login fails;
 * `onAbout` opens the presentation page ("What is this?").
 */
export default function LoginScreen({ onLogin, onAbout }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || username.trim() === '' || password === '') return;
    setBusy(true);
    setError(null);
    try {
      await onLogin(username.trim(), password);
    } catch (rejection) {
      setError(loginMessage(rejection));
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="login__card" onSubmit={submit} aria-label="Log in">
        <div className="login__brand">
          <BrandLogo size={40} />
        </div>
        <p className="login__hint">Log in to see your offers.</p>
        {error && <Banner type="danger" description={error} closeIcon={null} className="login__error" role="alert" />}
        <label className="login__field">
          Username
          <Input
            value={username}
            onChange={setUsername}
            autoComplete="username"
            autoFocus
            aria-label="Username"
            size="large"
          />
        </label>
        <label className="login__field">
          Password
          <Input
            mode="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            aria-label="Password"
            size="large"
          />
        </label>
        <Button
          htmlType="submit"
          theme="solid"
          type="primary"
          size="large"
          block
          loading={busy}
          disabled={username.trim() === '' || password === ''}
        >
          Log in
        </Button>
        {onAbout && (
          <Button theme="borderless" type="tertiary" block onClick={onAbout}>
            What is this?
          </Button>
        )}
      </form>
    </main>
  );
}
