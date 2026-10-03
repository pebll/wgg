/** "42 seconds", "1 minute", "3 minutes"; "a minute" when the server gave no usable time. */
export function formatRetry(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'a minute';
  if (seconds < 60) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** What the login form shows for a failed login request (a rejection of xhrSend, or a network error). */
export function loginMessage(rejection) {
  if (rejection?.status === 429) {
    return `Too many login attempts. Try again in ${formatRetry(rejection.retryAfterSeconds)}.`;
  }
  const message = rejection?.json?.error;
  if (rejection?.status === 401 && typeof message === 'string' && message !== '') return message;
  if (rejection?.status === undefined) return 'Could not reach the server. Try again.';
  return 'Login failed. Try again.';
}
