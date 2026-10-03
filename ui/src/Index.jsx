import { createRoot } from 'react-dom/client';
import { LocaleProvider, semiGlobal } from '@douyinfe/semi-ui-19';
import en_US from '@douyinfe/semi-ui-19/lib/es/locale/source/en_US';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Root from './Root.jsx';
import './Index.less';

// Semi's imperative components (Toast, Modal.confirm, ...) must render through React 19's createRoot.
semiGlobal.config.createRoot = createRoot;

createRoot(document.getElementById('wgg')).render(
  <LocaleProvider locale={en_US}>
    <ErrorBoundary onBack={() => window.location.assign('#/')}>
      <Root />
    </ErrorBoundary>
  </LocaleProvider>,
);
