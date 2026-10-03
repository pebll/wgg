import { describe, it, expect } from 'vitest';
import { parseRoute, routeHash, visibleView } from '../../ui/src/services/route.js';

describe('#ui route parsing', () => {
  it('reads the route from the location hash, tolerant of case and a trailing slash', () => {
    expect(parseRoute('#/about')).toBe('about');
    expect(parseRoute('#/About/')).toBe('about');
    expect(parseRoute('#/login')).toBe('login');
  });
  it('treats an empty or unknown hash as home', () => {
    expect(parseRoute('')).toBe('home');
    expect(parseRoute('#')).toBe('home');
    expect(parseRoute('#/nope')).toBe('home');
    expect(parseRoute(undefined)).toBe('home');
    expect(parseRoute(null)).toBe('home');
  });
  it('builds the relative hash of a route (home has none)', () => {
    expect(routeHash('about')).toBe('#/about');
    expect(routeHash('login')).toBe('#/login');
    expect(routeHash('home')).toBe('');
    expect(parseRoute(routeHash('about'))).toBe('about');
  });
});

describe('#ui visible view', () => {
  it('shows the presentation to visitors, and the login form only on #/login', () => {
    expect(visibleView('home', false)).toBe('about');
    expect(visibleView('about', false)).toBe('about');
    expect(visibleView('login', false)).toBe('login');
  });
  it('shows the app to a logged-in user, the presentation only on #/about', () => {
    expect(visibleView('home', true)).toBe('app');
    expect(visibleView('login', true)).toBe('app');
    expect(visibleView('about', true)).toBe('about');
  });
});
