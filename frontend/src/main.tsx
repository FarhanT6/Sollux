import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App';
import './styles/globals.css';

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!CLERK_KEY) throw new Error('VITE_CLERK_PUBLISHABLE_KEY is required');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={CLERK_KEY}>
      <App />
    </ClerkProvider>
  </React.StrictMode>
);
