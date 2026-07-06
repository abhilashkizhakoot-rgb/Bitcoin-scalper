import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { getApiBaseUrl as getRawApiBaseUrl } from './utils/api.ts';

const getApiBaseUrl = (): string => {
  const url = getRawApiBaseUrl();
  return (url && url.endsWith("/")) ? url.slice(0, -1) : url;
};

// Global Patch for window.fetch to handle relative requests under sandboxed iframes
const originalFetch = window.fetch;
if (originalFetch) {
  try {
    const patchedFetch = function (input: RequestInfo | URL, init?: RequestInit) {
      let resolvedInput = input;
      if (typeof input === "string") {
        if (input.startsWith("/")) {
          const baseUrl = getApiBaseUrl();
          if (baseUrl) {
            resolvedInput = baseUrl + input;
          }
        } else {
          try {
            const urlObj = new URL(input);
            if (urlObj.protocol === "about:" || urlObj.origin === "null") {
              const baseUrl = getApiBaseUrl();
              if (baseUrl && baseUrl.startsWith("http")) {
                resolvedInput = new URL(urlObj.pathname + urlObj.search, baseUrl).href;
              }
            }
          } catch (e) {
            if (input.startsWith("null/")) {
              const baseUrl = getApiBaseUrl();
              if (baseUrl) {
                resolvedInput = baseUrl + input.substring(4);
              }
            }
          }
        }
      } else if (input instanceof URL && input.pathname.startsWith("/")) {
        const baseUrl = getApiBaseUrl();
        if (baseUrl && baseUrl.startsWith("http") && (input.protocol === "about:" || input.origin === "null")) {
          try {
            resolvedInput = new URL(input.pathname + input.search, baseUrl).href;
          } catch (e) {}
        }
      } else if (input instanceof Request) {
        const requestUrl = input.url;
        try {
          const urlObj = new URL(requestUrl);
          if (urlObj.pathname.startsWith("/") && (urlObj.protocol === "about:" || urlObj.origin === "null" || urlObj.host === "null")) {
            const baseUrl = getApiBaseUrl();
            if (baseUrl && baseUrl.startsWith("http")) {
              const newUrl = new URL(urlObj.pathname + urlObj.search, baseUrl).href;
              resolvedInput = new Request(newUrl, input);
            }
          }
        } catch (e) {
          if (requestUrl.startsWith("/")) {
            const baseUrl = getApiBaseUrl();
            if (baseUrl && baseUrl.startsWith("http")) {
              try {
                resolvedInput = new Request(baseUrl + requestUrl, input);
              } catch (err) {}
            }
          }
        }
      }
      return originalFetch(resolvedInput, init);
    };

    try {
      Object.defineProperty(window, "fetch", {
        value: patchedFetch,
        writable: true,
        configurable: true,
      });
    } catch (e) {
      window.fetch = patchedFetch;
    }
  } catch (err) {
    console.warn("Failed to patch window.fetch globally:", err);
  }
}

// Global Patch for EventSource to handle relative streams under sandboxed iframes
const OriginalEventSource = window.EventSource;
if (OriginalEventSource) {
  try {
    class PatchedEventSource extends OriginalEventSource {
      constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        let resolvedUrl = url;
        if (typeof url === "string") {
          if (url.startsWith("/")) {
            const baseUrl = getApiBaseUrl();
            if (baseUrl && baseUrl.startsWith("http")) {
              resolvedUrl = baseUrl + url;
            }
          } else {
            try {
              const urlObj = new URL(url);
              if (urlObj.protocol === "about:" || urlObj.origin === "null") {
                const baseUrl = getApiBaseUrl();
                if (baseUrl && baseUrl.startsWith("http")) {
                  resolvedUrl = new URL(urlObj.pathname + urlObj.search, baseUrl).href;
                }
              }
            } catch (e) {
              if (url.startsWith("null/")) {
                const baseUrl = getApiBaseUrl();
                if (baseUrl && baseUrl.startsWith("http")) {
                  resolvedUrl = baseUrl + url.substring(4);
                }
              }
            }
          }
        } else if (url instanceof URL && url.pathname.startsWith("/")) {
          const baseUrl = getApiBaseUrl();
          if (baseUrl && baseUrl.startsWith("http") && (url.protocol === "about:" || url.origin === "null")) {
            try {
              resolvedUrl = new URL(url.pathname + url.search, baseUrl).href;
            } catch (e) {}
          }
        }
        
        let finalUrl = resolvedUrl instanceof URL ? resolvedUrl.href : String(resolvedUrl);
        
        // Ensure finalUrl is absolute for EventSource compatibility (especially Safari/WebKit)
        if (typeof window !== "undefined") {
          const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(finalUrl);
          if (!isAbsolute) {
            try {
              const baseUrl = getApiBaseUrl();
              if (baseUrl && baseUrl.startsWith("http")) {
                finalUrl = new URL(finalUrl, baseUrl).href;
              } else if (window.location && window.location.href && !window.location.href.startsWith("about:")) {
                finalUrl = new URL(finalUrl, window.location.href).href;
              }
            } catch (e) {
              console.warn("Failed to absolute-resolve EventSource URL:", finalUrl, e);
            }
          }
        }
        
        super(finalUrl, eventSourceInitDict);
      }
    }

    try {
      Object.defineProperty(window, "EventSource", {
        value: PatchedEventSource,
        writable: true,
        configurable: true,
      });
    } catch (e) {
      (window as any).EventSource = PatchedEventSource;
    }
  } catch (err) {
    console.warn("Failed to patch EventSource globally:", err);
  }
}

createRoot(document.getElementById('root')!).render(
  <App />
);
