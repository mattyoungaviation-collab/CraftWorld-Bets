function getAuthToken() {
  const stored = localStorage.getItem("cw_bets_token");
  if (stored) return stored;
  return null;
}

async function authFetch(input: RequestInfo, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const token = getAuthToken();
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }
  return fetch(input, { ...init, headers, credentials: "include" });
}

export async function placeCrashBet(amount: number) {
  const response = await authFetch("/api/crash/bet", {
    method: "POST",
    body: JSON.stringify({ amount }),
  });
  const json = await response.json();
  if (!response.ok || !json?.ok) {
    throw new Error(json?.error || "Failed to place crash bet");
  }
  return json;
}

export async function cashoutCrash() {
  const response = await authFetch("/api/crash/cashout", { method: "POST" });
  const json = await response.json();
  if (!response.ok || !json?.ok) {
    throw new Error(json?.error || "Failed to cash out");
  }
  return json;
}
