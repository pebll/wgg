import { useEffect, useState } from 'react';
import { Spin } from '@douyinfe/semi-ui-19';
import About from './components/About.jsx';
import App from './App.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import { useRoute } from './hooks/useRoute.js';
import { useSession } from './hooks/useSession.js';
import { visibleView } from './services/route.js';
import { applyTheme, initialTheme, nextTheme, saveStored } from './services/theme.js';

/**
 * Gate: visitors get the presentation page and, from its "Log in", the login form; a session gets the app. The
 * presentation stays reachable for a logged-in user at #/about.
 */
export default function Root() {
  const { user, loading, login, logout, setTargetName } = useSession();
  const [route, navigate] = useRoute();
  // The public pages follow the stored/system theme; once the app is shown it manages the theme itself.
  const [theme, setTheme] = useState(initialTheme);
  const view = visibleView(route, Boolean(user));
  useEffect(() => {
    if (view !== 'app') applyTheme(theme);
  }, [view, theme]);
  // Logged in: leave the #/login hash behind.
  useEffect(() => {
    if (user && route === 'login') navigate('home', { replace: true });
  }, [user, route, navigate]);

  const toggleTheme = () => {
    const next = nextTheme(theme);
    saveStored(next);
    setTheme(next);
  };

  if (loading) {
    return (
      <div className="login">
        <Spin size="large" />
      </div>
    );
  }
  if (view === 'about') {
    return (
      <About
        loggedIn={Boolean(user)}
        theme={theme}
        onToggleTheme={toggleTheme}
        onLogin={() => navigate('login')}
        onBack={() => navigate('home')}
      />
    );
  }
  if (view === 'login') return <LoginScreen onLogin={login} onAbout={() => navigate('about')} />;
  return <App user={user} onLogout={logout} onAbout={() => navigate('about')} onTargetName={setTargetName} />;
}
