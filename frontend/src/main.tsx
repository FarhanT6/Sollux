import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App';
import './styles/globals.css';

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

// Shown when the app is built without a Clerk key. Deliberately plain — it
// must not depend on anything that could itself be missing at this point.
function ConfigError() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#111', color: '#eee', fontFamily: 'Inter, system-ui, sans-serif', padding: '2rem',
    }}>
      <div style={{ maxWidth: 520 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Sollux isn’t configured</h1>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: '#aaa' }}>
          This build is missing <code style={{ color: '#F5A623' }}>VITE_CLERK_PUBLISHABLE_KEY</code>.
          Set it in the deployment’s environment variables (or in <code>frontend/.env</code> locally)
          and redeploy — it is read at build time, so restarting alone won’t pick it up.
        </p>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);

// This guard used to be a bare top-level `throw`. Vite inlines a missing env
// var as the literal `undefined`, which makes `!CLERK_KEY` statically true, so
// Rollup treated the throw as unconditional and dead-code-eliminated every
// statement after it — including the render call below. The build still
// succeeded, but shipped a bundle with no application code in it at all, and
// the only symptom was a blank page. vite.config.ts now fails the production
// build outright; this keeps the failure legible if one ever gets through.
if (!CLERK_KEY) {
  root.render(<ConfigError />);
} else {
  root.render(
    <React.StrictMode>
      <ClerkProvider publishableKey={CLERK_KEY}>
        <App />
      </ClerkProvider>
    </React.StrictMode>
  );
}
