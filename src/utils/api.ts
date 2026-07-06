/**
 * Helper to determine the API Base URL in sandboxed / iframe environments
 */
export function getApiBaseUrl(): string {
  const url = getRawApiBaseUrl();
  let processed = url;
  if (url && url.includes(".run.app") && url.startsWith("http://")) {
    processed = url.replace(/^http:\/\//i, "https://");
    console.debug(`[getApiBaseUrl] Upgraded insecure Cloud Run base URL: "${url}" -> "${processed}"`);
  }
  if (processed && processed.endsWith("/")) {
    processed = processed.slice(0, -1);
  }
  return processed;
}

function getRawApiBaseUrl(): string {
  // 0. Use server-injected base URL if present (extremely reliable under iframe sandboxing)
  if (typeof window !== "undefined" && (window as any).__API_BASE_URL__) {
    const injected = (window as any).__API_BASE_URL__;
    console.debug(`[getApiBaseUrl] Step 0: Injected URL found: "${injected}"`);
    if (injected && typeof injected === "string" && !injected.includes("null") && injected.trim() !== "") {
      const isClientLocal = window.location && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.hostname === "0.0.0.0");
      const isInjectedLocal = injected.includes("localhost") || injected.includes("127.0.0.1") || injected.includes("0.0.0.0");
      if (isClientLocal || !isInjectedLocal) {
        console.debug(`[getApiBaseUrl] Step 0: Using injected URL: "${injected}"`);
        return injected;
      }
    }
  }

  // Direct helper to extract an origin from a URL string without applying CDN filters.
  const extractOriginDirect = (str: string): string | null => {
    if (!str) return null;
    try {
      // Handle blob URLs correctly by extracting the underlying origin
      let urlToCheck = str;
      if (str.startsWith("blob:")) {
        urlToCheck = str.substring(5);
      }
      const match = urlToCheck.match(/(https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?)/);
      if (match) {
        return match[1];
      }
    } catch (e) {}
    return null;
  };

  // Helper with filter logic for resource/CDN URLs to avoid choosing them as base API URLs.
  const extractOriginWithFilter = (str: string): string | null => {
    const origin = extractOriginDirect(str);
    if (!origin) return null;
    const lower = origin.toLowerCase();
    
    // Check for standard CDN and API platforms to filter out.
    if (
      lower.includes("ai.studio") ||
      lower.includes("apis.google.com") ||
      lower.includes("maps.google.com") ||
      lower.includes("googleapis.com") ||
      lower.includes("google-analytics.com") ||
      lower.includes("unpkg.com") ||
      lower.includes("cdnjs.cloudflare.com") ||
      lower.includes("jsdelivr.net") ||
      lower.includes("github.com")
    ) {
      return null;
    }
    return origin;
  };

  // 1. Direct window.location protocol and host check
  if (typeof window !== "undefined" && window.location) {
    try {
      const protocol = window.location.protocol;
      const host = window.location.host;
      if ((protocol === "http:" || protocol === "https:") && host && host !== "null" && host !== "") {
        const res = `${protocol}//${host}`;
        console.debug(`[getApiBaseUrl] Step 1: Resolved to "${res}"`);
        return res;
      }
    } catch (e) {}

    // 1b. Check window.location.href
    try {
      if (window.location.href) {
        const origin = extractOriginWithFilter(window.location.href);
        if (origin) {
          console.debug(`[getApiBaseUrl] Step 1b: window.location.href: "${window.location.href}", extracted: "${origin}"`);
          return origin;
        }
      }
    } catch (e) {}
  }

  // 2. Check document.baseURI
  if (typeof document !== "undefined" && document.baseURI) {
    try {
      const origin = extractOriginWithFilter(document.baseURI);
      if (origin) {
        console.debug(`[getApiBaseUrl] Step 2: document.baseURI: "${document.baseURI}", extracted: "${origin}"`);
        return origin;
      }
    } catch (e) {}
  }

  // 3. Try import.meta.url
  if (typeof import.meta !== "undefined" && import.meta.url) {
    try {
      const origin = extractOriginWithFilter(import.meta.url);
      if (origin) {
        console.debug(`[getApiBaseUrl] Step 3: import.meta.url: "${import.meta.url}", extracted: "${origin}"`);
        return origin;
      }
    } catch (e) {}
  }

  // 4. Try same-origin parent context
  if (typeof window !== "undefined") {
    try {
      if (window.parent && window.parent !== window) {
        if (window.parent.location && window.parent.location.href) {
          const origin = extractOriginWithFilter(window.parent.location.href);
          if (origin) {
            console.debug(`[getApiBaseUrl] Step 4: window.parent.location.href extracted: "${origin}"`);
            return origin;
          }
        }
      }
    } catch (e) {}
    try {
      if (window.top && window.top !== window) {
        if (window.top.location && window.top.location.href) {
          const origin = extractOriginWithFilter(window.top.location.href);
          if (origin) {
            console.debug(`[getApiBaseUrl] Step 4b: window.top.location.href extracted: "${origin}"`);
            return origin;
          }
        }
      }
    } catch (e) {}
  }

  // 5. Scan document script, link, img elements for absolute URLs (ultimate DOM scanning)
  if (typeof document !== "undefined") {
    try {
      // Scripts
      const scripts = document.getElementsByTagName("script");
      for (let i = 0; i < scripts.length; i++) {
        const src = scripts[i].src || scripts[i].getAttribute("src") || "";
        if (src && src.startsWith("http")) {
          const origin = extractOriginWithFilter(src);
          if (origin) {
            console.debug(`[getApiBaseUrl] Step 5a (script): Found origin in script: "${origin}" from src: "${src}"`);
            return origin;
          }
        }
      }

      // Links (stylesheets, etc)
      const links = document.getElementsByTagName("link");
      for (let i = 0; i < links.length; i++) {
        const href = links[i].href || links[i].getAttribute("href") || "";
        if (href && href.startsWith("http")) {
          const origin = extractOriginWithFilter(href);
          if (origin) {
            console.debug(`[getApiBaseUrl] Step 5b (link): Found origin in link: "${origin}" from href: "${href}"`);
            return origin;
          }
        }
      }

      // Images
      const imgs = document.getElementsByTagName("img");
      for (let i = 0; i < imgs.length; i++) {
        const src = imgs[i].src || imgs[i].getAttribute("src") || "";
        if (src && src.startsWith("http")) {
          const origin = extractOriginWithFilter(src);
          if (origin) {
            console.debug(`[getApiBaseUrl] Step 5c (img): Found origin in img: "${origin}" from src: "${src}"`);
            return origin;
          }
        }
      }
    } catch (e) {}
  }

  // 6. Check performance resource timing entries
  if (typeof performance !== "undefined" && typeof performance.getEntries === "function") {
    try {
      const entries = performance.getEntries();
      for (let i = 0; i < entries.length; i++) {
        const name = entries[i].name;
        if (name && name.startsWith("http")) {
          const origin = extractOriginWithFilter(name);
          if (origin) {
            console.debug(`[getApiBaseUrl] Step 6: Found origin in performance entries: "${origin}" (from: "${name}")`);
            return origin;
          }
        }
      }
    } catch (e) {}
  }

  // 7. Try the compile-time injected APP_URL if available
  try {
    const injectedUrl = process.env.APP_URL;
    const origin = extractOriginWithFilter(injectedUrl || "");
    if (origin) {
      console.debug(`[getApiBaseUrl] Step 7: process.env.APP_URL: "${injectedUrl}", extracted: "${origin}"`);
      return origin;
    }
  } catch (e) {}

  // 8. Fallback to extracting from process.env.VITE_APP_URL or other envs
  try {
    for (const [key, value] of Object.entries((import.meta as any).env || {})) {
      if (typeof value === "string" && value.startsWith("http")) {
        const origin = extractOriginWithFilter(value);
        if (origin) {
          console.debug(`[getApiBaseUrl] Step 8: import.meta.env.${key}: "${value}", extracted: "${origin}"`);
          return origin;
        }
      }
    }
  } catch (e) {}

  // 9. Direct fallback to window.location.origin
  if (typeof window !== "undefined" && window.location && window.location.origin && window.location.origin !== "null" && window.location.origin !== "about:") {
    console.debug(`[getApiBaseUrl] Step 9: Using window.location.origin: "${window.location.origin}"`);
    return window.location.origin;
  }

  console.warn("[getApiBaseUrl] All steps failed to resolve base URL. Returning empty string.");
  return "";
}

/**
 * Drop-in wrapper for standard fetch that automatically prepends
 * the correct API Base URL if the path starts with /api/
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const baseUrl = getApiBaseUrl();
  let finalInput = input;
  
  if (typeof input === "string" && input.startsWith("/api/")) {
    const cleanBase = (baseUrl && baseUrl.endsWith("/")) ? baseUrl.slice(0, -1) : baseUrl;
    finalInput = (cleanBase && cleanBase.startsWith("http")) ? `${cleanBase}${input}` : input;
    console.debug(`[apiFetch] String path resolved: "${input}" -> "${finalInput}" (baseUrl: "${baseUrl}")`);
  } else if (input instanceof URL && input.pathname.startsWith("/api/")) {
    if (baseUrl && baseUrl.startsWith("http")) {
      try {
        const cleanBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
        finalInput = new URL(input.pathname + input.search + input.hash, cleanBase);
        console.debug(`[apiFetch] URL object resolved: "${input.href}" -> "${finalInput.href}"`);
      } catch (e) {
        console.error(`[apiFetch] Failed to construct absolute URL from: "${input.pathname}" with base: "${baseUrl}":`, e);
      }
    }
  }
  
  // Set credentials to "include" by default to ensure cookies are sent for iframe requests
  const fetchOptions: RequestInit = {
    credentials: "include",
    ...init
  };
  
  try {
    const response = await fetch(finalInput, fetchOptions);
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html") && typeof finalInput === "string" && finalInput.includes("/api/")) {
      console.warn(`[apiFetch] Endpoint "${finalInput}" returned HTML instead of JSON. The backend might be starting up or offline.`);
      throw new Error(`API returned HTML instead of JSON (backend might be offline or starting up)`);
    }
    return response;
  } catch (error) {
    console.warn(`[apiFetch] Network/Fetch error for "${typeof finalInput === "string" ? finalInput : (finalInput as any).url || (finalInput as any).href}":`, error);
    throw error;
  }
}

