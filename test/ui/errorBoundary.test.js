import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import ErrorBoundary from '../../ui/src/components/ErrorBoundary.jsx';

describe('#ui ErrorBoundary', () => {
  it('turns a render error into state that holds the error', () => {
    const error = new Error('boom');
    expect(ErrorBoundary.getDerivedStateFromError(error)).toEqual({ error });
  });

  it('renders its children while nothing failed', () => {
    const html = renderToString(React.createElement(ErrorBoundary, null, React.createElement('p', null, 'fine')));
    expect(html).toContain('fine');
  });

  it('shows the message with Reload and Back to offers once an error is held', () => {
    const boundary = new ErrorBoundary({ children: null });
    boundary.state = { error: new Error('boom') };
    const html = renderToString(boundary.render());
    expect(html).toContain('Something went wrong');
    expect(html).toContain('boom');
    expect(html).toContain('Reload');
    expect(html).toContain('Back to offers');
  });
});
