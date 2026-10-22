/**
 * Helper to determine the API Base URL in sandboxed / iframe environments
 */
export function getApiBaseUrl(): string {
  // If window.location is available and has a valid http/https origin, prefer relative paths ("")
  if (typeof window !== "undefined" && window.location) {
    const origin = window.location.origin;
    if (origin && origin !== "null" && origin !== "about:" && (origin.startsWith("http://") || origin.startsWith("https://"))) {
      return "";
    }
  }

  // Fallback for sandboxed iframes where window.location.origin is "null"
  if (typeof window !== "undefined") {
    const injected = (window as any).__API_BASE_URL__;
    if (injected && typeof injected === "string" && injected.trim() !== "" && !injected.includes("null") && injected.startsWith("http")) {
      return injected.endsWith("/") ? injected.slice(0, -1) : injected;
    }
    // Also check document.baseURI
    if (typeof document !== "undefined" && document.baseURI && document.baseURI.startsWith("http")) {
      try {
        const u = new URL(document.baseURI);
        if (u.origin && u.origin !== "null" && (u.origin.startsWith("http://") || u.origin.startsWith("https://"))) {
          return u.origin;
        }
      } catch (e) {}
    }
  }

  return "";
}

/**
 * Drop-in wrapper for standard fetch that automatically prepends
 * the correct API Base URL if the path starts with /api/
 * Never throws unhandled TypeError (Load failed / Failed to fetch);
 * returns a synthetic 503 response on network disconnection.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const baseUrl = getApiBaseUrl();
  let finalInput = input;
  
  if (typeof input === "string" && input.startsWith("/api/")) {
    if (baseUrl && baseUrl.startsWith("http")) {
      finalInput = `${baseUrl}${input}`;
    } else {
      finalInput = input;
    }
  } else if (input instanceof URL && input.pathname.startsWith("/api/")) {
    if (baseUrl && baseUrl.startsWith("http")) {
      try {
        finalInput = new URL(input.pathname + input.search + input.hash, baseUrl);
      } catch (e) {
        finalInput = input;
      }
    }
  }
  
  const fetchOptions: RequestInit = {
    ...init,
  };
  
  try {
    const response = await fetch(finalInput, fetchOptions);
    return response;
  } catch (error: any) {
    // Soft log network issues so normal transient drops don't explode into uncaught rejections
    console.debug(`[apiFetch] Request note for "${typeof finalInput === "string" ? finalInput : (finalInput as any).url || (finalInput as any).href}":`, error);
    // Return a synthetic 503 response instead of throwing unhandled TypeError: Load failed / Failed to fetch
    return new Response(
      JSON.stringify({ error: error?.message || "Network request failed", offline: true }),
      {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
