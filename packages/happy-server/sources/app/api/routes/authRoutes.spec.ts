import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { type Fastify } from "../types";

const { state, dbMock, resetState, createTokenMock } = vi.hoisted(() => {
    const state = {
        // publicKey hex -> account row. Empty means nobody has registered yet.
        accounts: new Map<string, { id: string }>(),
        upsertCalls: 0,
    };

    const resetState = () => {
        state.accounts.clear();
        state.upsertCalls = 0;
    };

    const accountFindUnique = vi.fn(async (args: any) => {
        return state.accounts.get(args.where.publicKey) ?? null;
    });

    const accountUpsert = vi.fn(async (args: any) => {
        state.upsertCalls++;
        const key = args.where.publicKey;
        const existing = state.accounts.get(key);
        if (existing) {
            return existing;
        }
        const row = { id: `account-${state.accounts.size + 1}` };
        state.accounts.set(key, row);
        return row;
    });

    const dbMock = {
        account: { findUnique: accountFindUnique, upsert: accountUpsert },
        terminalAuthRequest: { upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
        accountAuthRequest: { upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    };

    const createTokenMock = vi.fn(async (accountId: string) => `token-for-${accountId}`);

    return { state, dbMock, resetState, createTokenMock };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/app/auth/auth", () => ({ auth: { createToken: createTokenMock } }));
vi.mock("@/utils/log", () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { authRoutes } from "./authRoutes";

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });
    authRoutes(typed);
    await typed.ready();
    return typed;
}

/**
 * tweetnacl types its output as Uint8Array<ArrayBufferLike>, while privacy-kit's
 * Bytes is Uint8Array<ArrayBuffer>. Copying through a fresh Uint8Array narrows
 * the buffer type without reaching for a cast.
 */
function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
    return new Uint8Array(value);
}

/**
 * A real signed /v1/auth body. The endpoint verifies the signature with
 * tweetnacl, so these have to be genuine — a stub keypair would be rejected
 * before reaching the registration gate we are testing.
 */
function signedAuthBody() {
    const keyPair = tweetnacl.sign.keyPair();
    const publicKey = bytes(keyPair.publicKey);
    const challenge = bytes(tweetnacl.randomBytes(32));
    const signature = bytes(tweetnacl.sign.detached(challenge, keyPair.secretKey));
    return {
        publicKeyHex: privacyKit.encodeHex(publicKey),
        body: {
            publicKey: privacyKit.encodeBase64(publicKey),
            challenge: privacyKit.encodeBase64(challenge),
            signature: privacyKit.encodeBase64(signature),
        },
    };
}

describe("authRoutes — HAPPY_REGISTRATION gate on POST /v1/auth", () => {
    let app: Fastify | undefined;
    const originalEnv = process.env.HAPPY_REGISTRATION;

    beforeEach(() => {
        resetState();
        createTokenMock.mockClear();
        delete process.env.HAPPY_REGISTRATION;
    });

    afterEach(async () => {
        if (app) {
            await app.close();
            app = undefined;
        }
        if (originalEnv === undefined) {
            delete process.env.HAPPY_REGISTRATION;
        } else {
            process.env.HAPPY_REGISTRATION = originalEnv;
        }
    });

    it("defaults to open: an unknown keypair self-registers, matching upstream behaviour", async () => {
        app = await createApp();
        const { body } = signedAuthBody();

        const res = await app.inject({ method: "POST", url: "/v1/auth", payload: body });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ success: true, token: "token-for-account-1" });
        expect(state.upsertCalls).toBe(1);
    });

    it("closed: an unknown keypair is rejected and no account row is written", async () => {
        process.env.HAPPY_REGISTRATION = "closed";
        app = await createApp();
        const { body } = signedAuthBody();

        const res = await app.inject({ method: "POST", url: "/v1/auth", payload: body });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "Registration is closed" });
        // The point of the gate: the upsert must never run for an unknown key,
        // because upsert is the only account-creation site in the server.
        expect(state.upsertCalls).toBe(0);
        expect(createTokenMock).not.toHaveBeenCalled();
    });

    it("closed: an already-registered keypair still logs in", async () => {
        process.env.HAPPY_REGISTRATION = "closed";
        app = await createApp();
        const { publicKeyHex, body } = signedAuthBody();
        state.accounts.set(publicKeyHex, { id: "account-existing" });

        const res = await app.inject({ method: "POST", url: "/v1/auth", payload: body });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ success: true, token: "token-for-account-existing" });
    });

    it("closed: a bad signature is still rejected as 401, not masked by the gate", async () => {
        process.env.HAPPY_REGISTRATION = "closed";
        app = await createApp();
        const { body } = signedAuthBody();
        const tampered = { ...body, challenge: privacyKit.encodeBase64(bytes(tweetnacl.randomBytes(32))) };

        const res = await app.inject({ method: "POST", url: "/v1/auth", payload: tampered });

        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "Invalid signature" });
    });

    it("an unrecognised value throws at startup instead of falling back to open", async () => {
        // A typo in a security switch must fail loudly. 'close' is the one
        // people actually type.
        process.env.HAPPY_REGISTRATION = "close";

        await expect(createApp()).rejects.toThrow(/Invalid HAPPY_REGISTRATION value 'close'/);
    });
});
