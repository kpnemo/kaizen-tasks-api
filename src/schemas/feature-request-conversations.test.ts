import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as constants from "../lib/interview-constants.js";
import {
  ConversationEventSchema,
  ConversationMessageSchema,
  ConversationSchema,
  ConversationTurnBody,
  EMPTY_DRAFT,
  FeatureRequestDraftSchema,
  FINISHED_CONTENT,
  InterviewQuestionSchema,
  MAX_TURN_CONTENT,
  ReportTurnSchema,
  RubricScoreSchema,
  SKIPPED_CONTENT,
} from "./feature-request-conversations.js";
import { FeatureRequestBody } from "./feature-requests.js";
import { generateOpenApiDocument } from "./index.js";

const ISO = "2026-09-10T09:00:00.000Z";

const score = {
  clarity: 4,
  complexity: 2,
  risk: 2,
  archChange: false,
  readiness: 16,
  reasons: {
    clarity: "Three checkable criteria and a stated scope.",
    complexity: "One feature folder in the web app.",
    risk: "A new control that cannot affect stored data.",
  },
};

const conversation = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "open",
  messages: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      role: "assistant",
      content: "Tell me the idea in a sentence or two.",
      at: "2026-09-10T09:00:00.000Z",
      options: ["A", "B", "C"],
    },
  ],
  draft: EMPTY_DRAFT,
  score: null,
  questionCount: 0,
  stillMissing: [],
  issueNumber: null,
  createdAt: "2026-09-10T09:00:00.000Z",
  updatedAt: "2026-09-10T09:00:00.000Z",
};

describe("ConversationTurnBody", () => {
  it("trims content and rejects an empty or oversized answer", () => {
    expect(ConversationTurnBody.parse({ content: "  hello  " }).content).toBe("hello");
    expect(ConversationTurnBody.safeParse({ content: "   " }).success).toBe(false);
    expect(ConversationTurnBody.safeParse({ content: "x".repeat(MAX_TURN_CONTENT) }).success).toBe(
      true,
    );
    expect(
      ConversationTurnBody.safeParse({ content: "x".repeat(MAX_TURN_CONTENT + 1) }).success,
    ).toBe(false);
  });

  it("takes an optional skip flag and still requires content", () => {
    expect(ConversationTurnBody.parse({ content: SKIPPED_CONTENT, skip: true }).skip).toBe(true);
    expect(ConversationTurnBody.parse({ content: "a" }).skip).toBeUndefined();
    expect(ConversationTurnBody.safeParse({ skip: true }).success).toBe(false);
  });

  it("takes an optional finish flag and rejects finish together with skip", () => {
    expect(ConversationTurnBody.parse({ content: FINISHED_CONTENT, finish: true }).finish).toBe(
      true,
    );
    expect(
      ConversationTurnBody.safeParse({ content: FINISHED_CONTENT, finish: true, skip: true })
        .success,
    ).toBe(false);
  });
});

describe("InterviewQuestionSchema", () => {
  it("requires a recommended answer alongside the options", () => {
    expect(
      InterviewQuestionSchema.safeParse({ text: "Who?", options: ["A", "B"], recommended: "A" })
        .success,
    ).toBe(true);
    expect(InterviewQuestionSchema.safeParse({ text: "Who?", options: ["A", "B"] }).success).toBe(
      false,
    );
  });
});

describe("ConversationMessageSchema", () => {
  it("parses rows stored before recommended and finished existed", () => {
    const old = { id: randomUUID(), role: "assistant", content: "Who?", at: ISO, options: ["A"] };
    expect(ConversationMessageSchema.parse(old).recommended).toBeUndefined();
    const finished = {
      id: randomUUID(),
      role: "user",
      content: FINISHED_CONTENT,
      at: ISO,
      finished: true,
    };
    expect(ConversationMessageSchema.parse(finished).finished).toBe(true);
  });
});

describe("RubricScoreSchema", () => {
  it("accepts the rubric output shape and requires reasons", () => {
    expect(RubricScoreSchema.parse(score)).toEqual(score);
    const { reasons: _dropped, ...withoutReasons } = score;
    expect(RubricScoreSchema.safeParse(withoutReasons).success).toBe(false);
  });

  it("bounds every scale to the rubric's ranges", () => {
    expect(RubricScoreSchema.safeParse({ ...score, clarity: 6 }).success).toBe(false);
    expect(RubricScoreSchema.safeParse({ ...score, risk: 0 }).success).toBe(false);
    expect(RubricScoreSchema.safeParse({ ...score, readiness: 21 }).success).toBe(false);
    expect(RubricScoreSchema.safeParse({ ...score, readiness: 3 }).success).toBe(false);
  });
});

describe("ConversationSchema", () => {
  it("accepts a fresh conversation and the empty draft", () => {
    expect(ConversationSchema.parse(conversation).status).toBe("open");
    expect(FeatureRequestDraftSchema.parse(EMPTY_DRAFT)).toEqual(EMPTY_DRAFT);
  });

  it("requires all five draft fields", () => {
    const { outOfScope: _dropped, ...partial } = EMPTY_DRAFT;
    expect(ConversationSchema.safeParse({ ...conversation, draft: partial }).success).toBe(false);
  });
});

describe("ConversationEventSchema", () => {
  it("discriminates the four stream events on `event`", () => {
    expect(ConversationEventSchema.parse({ event: "delta", data: { text: "hi" } }).event).toBe(
      "delta",
    );
    expect(ConversationEventSchema.parse({ event: "state", data: { conversation } }).event).toBe(
      "state",
    );
    expect(
      ConversationEventSchema.parse({
        event: "error",
        data: { code: "UPSTREAM_ERROR", message: "boom" },
      }).event,
    ).toBe("error");
    expect(ConversationEventSchema.parse({ event: "done", data: {} }).event).toBe("done");
    expect(ConversationEventSchema.safeParse({ event: "ping", data: {} }).success).toBe(false);
  });

  it("rejects an error event whose code is outside the closed enum", () => {
    expect(
      ConversationEventSchema.safeParse({ event: "error", data: { code: "NOPE", message: "x" } })
        .success,
    ).toBe(false);
  });
});

describe("ReportTurnSchema", () => {
  it("accepts a question turn and a done turn", () => {
    const asking = {
      question: {
        text: "Who is the user?",
        options: ["A supervisor", "An agent", "A planner"],
        recommended: "A supervisor",
      },
      draft: EMPTY_DRAFT,
      score,
      done: false,
      stillMissing: [],
    };
    expect(ReportTurnSchema.parse(asking).question?.options).toHaveLength(3);
    expect(ReportTurnSchema.parse({ ...asking, question: null, done: true }).done).toBe(true);
  });

  it("requires one to four options", () => {
    const withOptions = (options: string[]) => ({
      question: { text: "Who?", options, recommended: options[0] },
      draft: EMPTY_DRAFT,
      score,
      done: false,
      stillMissing: [],
    });
    expect(ReportTurnSchema.safeParse(withOptions([])).success).toBe(false);
    expect(ReportTurnSchema.safeParse(withOptions(["a"])).success).toBe(true);
    expect(ReportTurnSchema.safeParse(withOptions(["a", "b", "c", "d"])).success).toBe(true);
    expect(ReportTurnSchema.safeParse(withOptions(["a", "b", "c", "d", "e"])).success).toBe(false);
  });
});

describe("the shared runtime constants", () => {
  it("are defined in lib and only re-exported by the schema module", () => {
    expect(EMPTY_DRAFT).toBe(constants.EMPTY_DRAFT);
    expect(SKIPPED_CONTENT).toBe(constants.SKIPPED_CONTENT);
    expect(constants.SKIPPED_CONTENT).toBe("(skipped)");
    expect(constants.TRANSCRIPT_OPENER).toBe("Start the interview.");
  });
});

describe("FeatureRequestBody", () => {
  it("takes an optional conversationId uuid", () => {
    const body = {
      title: "Bulk accept from the task list",
      problem: "Accepting suggestions one at a time is slow.",
      proposedBehavior: "A checkbox per task and an Accept all button.",
      acceptanceCriteria: "Selecting three tasks and pressing the button accepts every suggestion.",
    };
    expect(FeatureRequestBody.parse(body).conversationId).toBeUndefined();
    expect(
      FeatureRequestBody.parse({ ...body, conversationId: conversation.id }).conversationId,
    ).toBe(conversation.id);
    expect(FeatureRequestBody.safeParse({ ...body, conversationId: "nope" }).success).toBe(false);
  });
});

describe("the OpenAPI document", () => {
  const doc = generateOpenApiDocument();
  const paths = (doc.paths ?? {}) as Record<
    string,
    Record<string, { responses?: Record<string, { content?: Record<string, unknown> }> }>
  >;

  it("registers the three conversation routes", () => {
    expect(paths["/feature-requests/conversation"]?.get).toBeDefined();
    expect(paths["/feature-requests/conversation"]?.post).toBeDefined();
    expect(paths["/feature-requests/conversation/{id}/messages"]?.post).toBeDefined();
  });

  it("describes the messages route as text/event-stream carrying ConversationEvent", () => {
    const content =
      paths["/feature-requests/conversation/{id}/messages"]?.post?.responses?.["200"]?.content ??
      {};
    expect(Object.keys(content)).toEqual(["text/event-stream"]);
    expect(JSON.stringify(content)).toContain("ConversationEvent");
  });

  it("emits every new component", () => {
    const schemas = doc.components?.schemas ?? {};
    for (const name of [
      "Conversation",
      "ConversationStatus",
      "ConversationMessage",
      "FeatureRequestDraft",
      "RubricScore",
      "ConversationTurnBody",
      "ConversationEvent",
      "ConversationDeltaEvent",
      "ConversationStateEvent",
      "ConversationErrorEvent",
      "ConversationDoneEvent",
    ]) {
      expect(schemas[name], name).toBeDefined();
    }
  });
});
