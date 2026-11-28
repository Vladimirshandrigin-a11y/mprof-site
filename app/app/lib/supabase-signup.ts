const USER_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function supabaseSignupFetch(supabaseUrl: string, send: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  const signup = new URL(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/signup`);

  return async (input, init) => {
    const response = await send(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() !== "POST" || !response.ok) return response;

    const url = new URL(input instanceof Request ? input.url : input, signup.origin);
    if (url.origin !== signup.origin || url.pathname !== signup.pathname) return response;

    // GoTrue can return an unwrapped User when confirmation is pending.
    // auth-js 2.106.1 only reads the nested user.
    let user: unknown;
    try { user = await response.clone().json(); }
    catch { return response; }
    if (!user || typeof user !== "object" || !("id" in user) || typeof user.id !== "string"
      || !USER_ID.test(user.id) || !("identities" in user) || !Array.isArray(user.identities)
      || "user" in user || "session" in user || "access_token" in user) return response;

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return Response.json({ user }, { status: response.status, headers });
  };
}
