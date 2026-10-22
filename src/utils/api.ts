/**
 * Helper to determine the API Base URL in sandboxed / iframe environments
 */
export function getApiBaseUrl(): string {
  // If window.location is available and on standard web protocol, prefer relative paths ("")
  // Relative paths are naturally resolved by the browser to the current origin without CORS or protocol mismatches.
  if (typeof window !== "undefined" && window.location) {
    const origin = window.location.origin;
    if (origin && origin !== "null" && origin !== "about:" && (origin.startsWith("http://") || origin.startsWith("https://"))) {
      return "";
    }
  }

  // Fallback for sandboxed iframes where window.location.origin is "null"
  if (typeof window !== "undefined" && (window as any).__API_BASE_URL__) {
    const injected = (window as any).__API_BASE_URL__;
    if (injected && typeof injected === "string" && injected.trim() !== "" && !injected.includes("null") && injected.startsWith("http")) {
      return injected.endsWith("/") ? injected.slice(0, -1) : injected;
    }
  }

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
  } catch (error) {
    // Soft log network issues so normal transient drops don't explode into uncaught rejections
    console.debug(`[apiFetch] Request note for "${typeof finalInput === "string" ? finalInput : (finalInput as any).url || (finalInput as any).href}":`, error);
    throw error;
  }
}
