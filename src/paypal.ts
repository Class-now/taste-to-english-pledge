// PayPal Orders v2 + Payments v2, called over REST from the Worker.
// The flow the pledge needs: create an order with intent=AUTHORIZE (the learner approves a hold),
// authorize it, then later either void the authorization (learner kept the pledge, no money moves)
// or capture part of it (missed days are donated). Secrets come from Wrangler secrets only.

export const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

/** PayPal's public sandbox test Visa (developer.paypal.com test cards). Not a real card. */
const SANDBOX_TEST_CARD = { number: "4111111111111111", expiry: "2030-01", security_code: "123", name: "Sandbox Learner" };

export interface Money {
  currency_code: "USD";
  value: string;
}

export interface CreatedOrder {
  orderId: string;
  status: string;
  /** Where the learner approves the hold (PayPal Checkout). */
  approveUrl?: string;
}

export interface Authorization {
  orderId: string;
  authorizationId: string;
  status: string;
  amount: Money;
  expiresAt?: string;
}

export interface CaptureResult {
  captureId: string;
  status: string;
  amount: Money;
}

/** One REST call, as shown in the pledge's audit trail. Never contains secrets. */
export interface PayPalCall {
  method: string;
  path: string;
  status: number;
  debugId?: string;
  ms: number;
}

export interface PayPalClient {
  readonly mode: "sandbox" | "simulated";
  createAuthorizeOrder(opts: { amount: Money; description: string; customId: string; returnUrl: string; cancelUrl: string; requestId: string }): Promise<CreatedOrder>;
  authorizeOrder(orderId: string, requestId: string): Promise<Authorization>;
  createCardAuthorization(opts: { amount: Money; description: string; customId: string; requestId: string }): Promise<Authorization>;
  voidAuthorization(authorizationId: string): Promise<{ status: string }>;
  captureAuthorization(authorizationId: string, amount: Money, note: string, requestId: string): Promise<CaptureResult>;
  getAuthorization(authorizationId: string): Promise<{ status: string; amount: Money }>;
  /** Calls made by this client instance, oldest first. */
  readonly calls: PayPalCall[];
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issue?: string,
    readonly debugId?: string,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

export function usd(value: number): Money {
  return { currency_code: "USD", value: value.toFixed(2) };
}

type Fetch = typeof fetch;

export class HttpPayPalClient implements PayPalClient {
  readonly mode = "sandbox" as const;
  readonly calls: PayPalCall[] = [];
  private token?: { value: string; expires: number };

  constructor(
    private readonly clientId: string,
    private readonly secret: string,
    private readonly base: string = SANDBOX_BASE,
    private readonly fetchFn: Fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > this.now() + 60_000) return this.token.value;
    const started = this.now();
    const res = await this.fetchFn(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${this.clientId}:${this.secret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    this.calls.push({ method: "POST", path: "/v1/oauth2/token", status: res.status, ms: this.now() - started });
    if (!res.ok) throw new PayPalError("PayPal rejected the app credentials", res.status);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expires: this.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    const token = await this.accessToken();
    const started = this.now();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      prefer: "return=representation",
    };
    if (requestId) headers["paypal-request-id"] = requestId;
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const debugId = res.headers.get("paypal-debug-id") ?? undefined;
    this.calls.push({ method, path: path.replace(/[A-Z0-9]{10,}/g, ":id"), status: res.status, debugId, ms: this.now() - started });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const details = json.details as { issue?: string; description?: string }[] | undefined;
      const issue = details?.[0]?.issue ?? (json.name as string | undefined);
      throw new PayPalError(`PayPal ${method} ${path} failed: ${issue ?? res.status}`, res.status, issue, debugId);
    }
    return json as T;
  }

  async createAuthorizeOrder(opts: { amount: Money; description: string; customId: string; returnUrl: string; cancelUrl: string; requestId: string }): Promise<CreatedOrder> {
    const order = await this.call<{ id: string; status: string; links?: { rel: string; href: string }[] }>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: "pledge",
            custom_id: opts.customId,
            description: opts.description.slice(0, 127),
            soft_descriptor: "READPLEDGE",
            amount: opts.amount,
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "Taste-to-English Pledge",
              user_action: "CONTINUE",
              shipping_preference: "NO_SHIPPING",
              return_url: opts.returnUrl,
              cancel_url: opts.cancelUrl,
            },
          },
        },
      },
      opts.requestId,
    );
    const approve = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
    return { orderId: order.id, status: order.status, approveUrl: approve?.href };
  }

  /**
   * Sandbox-only shortcut for judges: the same AUTHORIZE order, paid with PayPal's published sandbox
   * test card (server-side constant, never typed in the browser), so the hold is placed without a buyer login.
   */
  async createCardAuthorization(opts: { amount: Money; description: string; customId: string; requestId: string }): Promise<Authorization> {
    if (this.base !== SANDBOX_BASE) throw new PayPalError("The test card only works in the sandbox", 400);
    const order = await this.call<{
      id: string;
      purchase_units: { payments?: { authorizations?: { id: string; status: string; amount: Money; expiration_time?: string }[] } }[];
    }>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "AUTHORIZE",
        purchase_units: [{ reference_id: "pledge", custom_id: opts.customId, description: opts.description.slice(0, 127), amount: opts.amount }],
        payment_source: { card: { ...SANDBOX_TEST_CARD } },
      },
      opts.requestId,
    );
    const auth = order.purchase_units[0]?.payments?.authorizations?.[0];
    if (!auth) throw new PayPalError("PayPal returned no authorization", 502);
    return { orderId: order.id, authorizationId: auth.id, status: auth.status, amount: auth.amount, expiresAt: auth.expiration_time };
  }

  async authorizeOrder(orderId: string, requestId: string): Promise<Authorization> {
    const order = await this.call<{
      id: string;
      purchase_units: { payments?: { authorizations?: { id: string; status: string; amount: Money; expiration_time?: string }[] } }[];
    }>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {}, requestId);
    const auth = order.purchase_units[0]?.payments?.authorizations?.[0];
    if (!auth) throw new PayPalError("PayPal returned no authorization", 502);
    return { orderId: order.id, authorizationId: auth.id, status: auth.status, amount: auth.amount, expiresAt: auth.expiration_time };
  }

  async voidAuthorization(authorizationId: string): Promise<{ status: string }> {
    await this.call("POST", `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`);
    return { status: "VOIDED" };
  }

  async captureAuthorization(authorizationId: string, amount: Money, note: string, requestId: string): Promise<CaptureResult> {
    const cap = await this.call<{ id: string; status: string; amount?: Money }>(
      "POST",
      `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
      { amount, final_capture: true, note_to_payer: note.slice(0, 255), soft_descriptor: "READPLEDGE" },
      requestId,
    );
    return { captureId: cap.id, status: cap.status, amount: cap.amount ?? amount };
  }

  async getAuthorization(authorizationId: string): Promise<{ status: string; amount: Money }> {
    return this.call("GET", `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`);
  }
}

/**
 * Stand-in used only when no PayPal credentials are configured (local dev, tests). The UI labels it
 * "simulated" so it is never mistaken for a sandbox call.
 */
export class SimulatedPayPalClient implements PayPalClient {
  readonly mode = "simulated" as const;
  readonly calls: PayPalCall[] = [];
  private seq = 0;
  private readonly auths = new Map<string, { status: string; amount: Money }>();

  private log(method: string, path: string, status = 201) {
    this.calls.push({ method, path, status, ms: 0 });
  }
  private id(prefix: string) {
    this.seq += 1;
    return `${prefix}${Date.now().toString(36).toUpperCase()}${this.seq}`;
  }

  async createAuthorizeOrder(opts: { amount: Money; returnUrl: string }): Promise<CreatedOrder> {
    this.log("POST", "/v2/checkout/orders");
    const orderId = this.id("SIMORDER");
    const url = new URL(opts.returnUrl);
    url.searchParams.set("token", orderId);
    return { orderId, status: "PAYER_ACTION_REQUIRED", approveUrl: url.toString() };
  }
  async createCardAuthorization(opts: { amount: Money }): Promise<Authorization> {
    this.log("POST", "/v2/checkout/orders");
    const authorizationId = this.id("SIMAUTH");
    this.auths.set(authorizationId, { status: "CREATED", amount: opts.amount });
    return { orderId: this.id("SIMORDER"), authorizationId, status: "CREATED", amount: opts.amount };
  }
  async authorizeOrder(orderId: string): Promise<Authorization> {
    this.log("POST", "/v2/checkout/orders/:id/authorize");
    const authorizationId = this.id("SIMAUTH");
    const amount = usd(7);
    this.auths.set(authorizationId, { status: "CREATED", amount });
    return { orderId, authorizationId, status: "CREATED", amount };
  }
  async voidAuthorization(authorizationId: string): Promise<{ status: string }> {
    this.log("POST", "/v2/payments/authorizations/:id/void", 204);
    this.auths.set(authorizationId, { status: "VOIDED", amount: usd(0) });
    return { status: "VOIDED" };
  }
  async captureAuthorization(_id: string, amount: Money): Promise<CaptureResult> {
    this.log("POST", "/v2/payments/authorizations/:id/capture");
    return { captureId: this.id("SIMCAP"), status: "COMPLETED", amount };
  }
  async getAuthorization(authorizationId: string): Promise<{ status: string; amount: Money }> {
    this.log("GET", "/v2/payments/authorizations/:id", 200);
    return this.auths.get(authorizationId) ?? { status: "CREATED", amount: usd(5) };
  }
}
