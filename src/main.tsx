import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { getApiBaseUrl } from './utils/api.ts';

// Handle sandboxed iframes where origin is "null" or "about:"
if (typeof window !== "undefined") {
  const isSandboxedNullOrigin = !window.location || window.location.origin === "null" || window.location.protocol === "about:";
  
  if (isSandboxedNullOrigin) {
    const originalFetch = window.fetch;
    const baseUrl = getApiBaseUrl();
    if (originalFetch && baseUrl && baseUrl.startsWith("http")) {
      window.fetch = function(input: RequestInfo | URL, init?: RequestInit) {
        if (typeof input === "string" && input.startsWith("/")) {
          return originalFetch(`${baseUrl}${input}`, init);
        }
        return originalFetch(input, init);
      };
    }
  }
}

createRoot(document.getElementById('root')!).render(
  <App />
);
