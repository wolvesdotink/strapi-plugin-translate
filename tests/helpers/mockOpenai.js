"use strict";

// Mockable openai SDK. Used by the openrouter provider tests via vi.mock.
//
// Usage:
//   import { vi } from "vitest";
//   import { setMockedResponses } from "./helpers/mockOpenai";
//   vi.mock("openai", () => require("./helpers/mockOpenaiModule"));
//
// The actual SDK shape we use:
//   new OpenAI({...}) -> { chat: { completions: { create(body, opts) -> response } } }

class FakeOpenAI {
  constructor(opts) {
    this.opts = opts;
    this.chat = {
      completions: {
        create: async (body, callOpts) => {
          const fn = FakeOpenAI._scriptedCreate;
          if (typeof fn !== "function") {
            throw new Error("mockOpenai: no scripted response set");
          }
          // Honor abort signal explicitly.
          if (callOpts?.signal?.aborted) {
            const e = new Error("aborted");
            e.name = "AbortError";
            throw e;
          }
          return fn(body, callOpts);
        },
      },
    };
  }
}

FakeOpenAI._scriptedCreate = null;
FakeOpenAI._calls = [];

const setMockedCreate = (fn) => {
  FakeOpenAI._scriptedCreate = async (body, opts) => {
    FakeOpenAI._calls.push({ body, opts });
    return fn(body, opts);
  };
};

const getMockedCalls = () => FakeOpenAI._calls.slice();

const resetMock = () => {
  FakeOpenAI._scriptedCreate = null;
  FakeOpenAI._calls = [];
};

// A canned success response builder — saves boilerplate in each test.
const okResponse = (translations) => ({
  model: "mock-model",
  choices: [
    {
      finish_reason: "stop",
      message: { content: JSON.stringify({ translations }) },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
});

module.exports = {
  FakeOpenAI,
  setMockedCreate,
  getMockedCalls,
  resetMock,
  okResponse,
};
