import { Component } from 'react';

/**
 * Catches a render error below it (plain markup, no Semi dependency, so the fallback itself cannot fail) so the page never goes blank: shows the message with "Reload" and "Back to offers"
 * and logs the error with its component stack. `resetKey` changing (e.g. another offer selected) clears the error;
 * `onBack` runs on "Back to offers" before the error is cleared.
 */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('wgg UI error:', error, info?.componentStack);
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  back = () => {
    this.props.onBack?.();
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app__crash" role="alert">
        <h2>Something went wrong</h2>
        <p>{error?.message ?? String(error)}</p>
        <button type="button" className="semi-button semi-button-primary" onClick={() => window.location.reload()}>
          <span className="semi-button-content">Reload</span>
        </button>{' '}
        <button type="button" className="semi-button semi-button-tertiary semi-button-borderless" onClick={this.back}>
          <span className="semi-button-content">Back to offers</span>
        </button>
      </div>
    );
  }
}
