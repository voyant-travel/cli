import { describe, expect, it, vi } from "vitest"

import { DeviceFlowError, runDeviceCodeFlow } from "../../src/lib/device-code.js"

interface MockResponse {
  status?: number
  body: unknown
}

function makeFetch(responses: MockResponse[]): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; init?: RequestInit }>
} {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let cursor = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    const r = responses[cursor]
    cursor += 1
    if (!r) throw new Error("No mock response left")
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }
  return { fetchImpl, calls }
}

const AUTHORIZE_OK = {
  body: {
    device_code: "dev_long_secret",
    user_code: "ABCD-1234",
    verification_uri: "https://app.voyant.travel/cli",
    verification_uri_complete: "https://app.voyant.travel/cli?user_code=ABCD-1234",
    expires_in: 600,
    interval: 5,
  },
} satisfies MockResponse

describe("runDeviceCodeFlow", () => {
  it("authorizes, polls past pending, and returns the token on 200", async () => {
    const { fetchImpl, calls } = makeFetch([
      AUTHORIZE_OK,
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "authorization_pending" } },
      {
        status: 200,
        body: {
          access_token: "tok_abc",
          token_type: "bearer",
          organization_id: "org_x",
          user_id: "user_y",
        },
      },
    ])

    const onCodes = vi.fn()

    const result = await runDeviceCodeFlow({
      apiUrl: "https://api.test",
      pollIntervalMs: 1,
      fetchImpl,
      onCodes,
    })

    expect(result).toEqual({
      accessToken: "tok_abc",
      organizationId: "org_x",
      userId: "user_y",
    })
    expect(calls[0]?.url).toBe("https://api.test/cli/v1/device/authorize")
    expect(calls[1]?.url).toBe("https://api.test/cli/v1/device/token")
    expect(onCodes).toHaveBeenCalledWith({
      userCode: "ABCD-1234",
      verificationUri: "https://app.voyant.travel/cli",
      verificationUriComplete: "https://app.voyant.travel/cli?user_code=ABCD-1234",
      expiresInSeconds: 600,
    })
  })

  it("strips trailing slashes from apiUrl", async () => {
    const { fetchImpl, calls } = makeFetch([
      AUTHORIZE_OK,
      {
        status: 200,
        body: {
          access_token: "tok",
          organization_id: "org",
          user_id: "user",
        },
      },
    ])

    await runDeviceCodeFlow({
      apiUrl: "https://api.test///",
      pollIntervalMs: 1,
      fetchImpl,
    })

    expect(calls[0]?.url).toBe("https://api.test/cli/v1/device/authorize")
    expect(calls[1]?.url).toBe("https://api.test/cli/v1/device/token")
  })

  it("treats slow_down the same as authorization_pending", async () => {
    const { fetchImpl } = makeFetch([
      AUTHORIZE_OK,
      { status: 400, body: { error: "slow_down" } },
      {
        status: 200,
        body: {
          access_token: "tok",
          organization_id: "org",
          user_id: "user",
        },
      },
    ])

    const result = await runDeviceCodeFlow({
      apiUrl: "https://api.test",
      pollIntervalMs: 1,
      fetchImpl,
    })
    expect(result.accessToken).toBe("tok")
  })

  it("throws DeviceFlowError(access_denied) on user denial", async () => {
    const { fetchImpl } = makeFetch([
      AUTHORIZE_OK,
      { status: 400, body: { error: "access_denied" } },
    ])

    await expect(
      runDeviceCodeFlow({
        apiUrl: "https://api.test",
        pollIntervalMs: 1,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "DeviceFlowError",
      code: "access_denied",
    })
  })

  it("throws DeviceFlowError(expired_token) on server expiry", async () => {
    const { fetchImpl } = makeFetch([
      AUTHORIZE_OK,
      { status: 400, body: { error: "expired_token" } },
    ])

    await expect(
      runDeviceCodeFlow({
        apiUrl: "https://api.test",
        pollIntervalMs: 1,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "expired_token" })
  })

  it("throws DeviceFlowError(invalid_grant) on consumed/missing code", async () => {
    const { fetchImpl } = makeFetch([
      AUTHORIZE_OK,
      { status: 400, body: { error: "invalid_grant" } },
    ])

    await expect(
      runDeviceCodeFlow({
        apiUrl: "https://api.test",
        pollIntervalMs: 1,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" })
  })

  it("throws DeviceFlowError(transport) when /authorize fails", async () => {
    const { fetchImpl } = makeFetch([{ status: 500, body: { error: "boom" } }])

    await expect(
      runDeviceCodeFlow({
        apiUrl: "https://api.test",
        pollIntervalMs: 1,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "transport" })
  })

  it("aborts cleanly when the signal is fired mid-poll", async () => {
    const controller = new AbortController()

    // Fire abort during the first sleep window.
    setTimeout(() => controller.abort(), 5)

    const { fetchImpl } = makeFetch([
      AUTHORIZE_OK,
      // Never reached: the sleep is aborted before the next poll.
      { status: 400, body: { error: "authorization_pending" } },
    ])

    await expect(
      runDeviceCodeFlow({
        apiUrl: "https://api.test",
        pollIntervalMs: 1000,
        fetchImpl,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(DeviceFlowError)
  })

  it("forwards name + clientInfo to /authorize", async () => {
    const { fetchImpl, calls } = makeFetch([
      AUTHORIZE_OK,
      {
        status: 200,
        body: {
          access_token: "tok",
          organization_id: "org",
          user_id: "user",
        },
      },
    ])

    await runDeviceCodeFlow({
      apiUrl: "https://api.test",
      pollIntervalMs: 1,
      fetchImpl,
      name: "voyant-cli on laptop",
      clientInfo: { hostname: "laptop", platform: "darwin" },
    })

    const authCall = calls[0]
    expect(authCall?.init?.body).toContain("voyant-cli on laptop")
    expect(authCall?.init?.body).toContain("darwin")
  })
})
