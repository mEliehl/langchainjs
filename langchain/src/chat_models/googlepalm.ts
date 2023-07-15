import { DiscussServiceClient } from "@google-ai/generativelanguage";
import type { protos } from "@google-ai/generativelanguage";
import { GoogleAuth } from "google-auth-library";
import { CallbackManagerForLLMRun } from "../callbacks/manager.js";
import { AIMessage, BaseMessage, ChatResult } from "../schema/index.js";
import { getEnvironmentVariable } from "../util/env.js";
import { BaseChatModel, BaseChatModelParams } from "./base.js";

export interface GooglePaLMChatInput extends BaseChatModelParams {
  /**
   * Model Name to use
   *
   * Note: The format must follow the pattern - `models/{model}`
   */
  modelName?: string;

  /**
   * Controls the randomness of the output.
   *
   * Values can range from [0.0,1.0], inclusive. A value closer to 1.0
   * will produce responses that are more varied and creative, while
   * a value closer to 0.0 will typically result in less surprising
   * responses from the model.
   *
   * Note: The default value varies by model
   */
  temperature?: number;

  /**
   * Top-p changes how the model selects tokens for output.
   *
   * Tokens are selected from most probable to least until the sum
   * of their probabilities equals the top-p value.
   *
   * For example, if tokens A, B, and C have a probability of
   * .3, .2, and .1 and the top-p value is .5, then the model will
   * select either A or B as the next token (using temperature).
   *
   * Note: The default value varies by model
   */
  topP?: number;

  /**
   * Top-k changes how the model selects tokens for output.
   *
   * A top-k of 1 means the selected token is the most probable among
   * all tokens in the model’s vocabulary (also called greedy decoding),
   * while a top-k of 3 means that the next token is selected from
   * among the 3 most probable tokens (using temperature).
   *
   * Note: The default value varies by model
   */
  topK?: number;

  examples?: protos.google.ai.generativelanguage.v1beta2.IExample[];

  /**
   * Google Palm API key to use
   */
  apiKey?: string;
}

export class ChatGooglePaLM
  extends BaseChatModel
  implements GooglePaLMChatInput
{
  get lc_secrets(): { [key: string]: string } | undefined {
    return {
      apiKey: "GOOGLE_PALM_API_KEY",
    };
  }

  modelName = "models/chat-bison-001";

  temperature?: number; // default value chosen based on model

  topP?: number; // default value chosen based on model

  topK?: number; // default value chosen based on model

  examples: protos.google.ai.generativelanguage.v1beta2.IExample[] = [];

  apiKey?: string;

  private client: DiscussServiceClient;

  constructor(fields?: GooglePaLMChatInput) {
    super(fields ?? {});

    this.modelName = fields?.modelName ?? this.modelName;

    this.temperature = fields?.temperature ?? this.temperature;
    if (this.temperature && (this.temperature < 0 || this.temperature > 1)) {
      throw new Error("`temperature` must be in the range of [0.0,1.0]");
    }

    this.topP = fields?.topP ?? this.topP;
    if (this.topP && this.topP < 0) {
      throw new Error("`topP` must be a positive integer");
    }

    this.topK = fields?.topK ?? this.topK;
    if (this.topK && this.topK < 0) {
      throw new Error("`topK` must be a positive integer");
    }

    this.examples = fields?.examples ?? this.examples;

    this.apiKey =
      fields?.apiKey ?? getEnvironmentVariable("GOOGLE_PALM_API_KEY");
    if (!this.apiKey) {
      throw new Error(
        "Please set an API key for Google Palm 2 in the environment variable GOOGLE_PALM_API_KEY or in the `apiKey` field of the GooglePalm constructor"
      );
    }

    this.client = new DiscussServiceClient({
      authClient: new GoogleAuth().fromAPIKey(this.apiKey),
    });
  }

  _combineLLMOutput() {
    return [];
  }

  _llmType() {
    return "googlepalm";
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const palmMessages = await this.caller.callWithOptions(
      { signal: options.signal },
      this._generateMessage.bind(this),
      this._mapBaseMessagesToPalmMessages(messages),
      this._getPalmContextInstruction(messages),
      this.examples
    );
    const chatResult = this._mapPalmMessagesToChatResult(palmMessages);

    // Google Palm doesn't provide streaming as of now. But to support streaming handlers
    // we call the handler with entire response text
    void runManager?.handleLLMNewToken(
      chatResult.generations.length > 0 ? chatResult.generations[0].text : ""
    );

    return chatResult;
  }

  protected async _generateMessage(
    messages: protos.google.ai.generativelanguage.v1beta2.IMessage[],
    context?: string,
    examples?: protos.google.ai.generativelanguage.v1beta2.IExample[]
  ): Promise<protos.google.ai.generativelanguage.v1beta2.IGenerateMessageResponse> {
    const [palmMessages] = await this.client.generateMessage({
      candidateCount: 1,
      model: this.modelName,
      temperature: this.temperature,
      topK: this.topK,
      topP: this.topP,
      prompt: {
        context,
        examples,
        messages,
      },
    });
    return palmMessages;
  }

  protected _getPalmContextInstruction(
    messages: BaseMessage[]
  ): string | undefined {
    // get the first message and checks if it's a system 'system' messages
    const systemMessage =
      messages.length > 0 && messages[0]._getType() === "system"
        ? messages[0]
        : undefined;
    return systemMessage?.content;
  }

  protected _mapBaseMessagesToPalmMessages(
    messages: BaseMessage[]
  ): protos.google.ai.generativelanguage.v1beta2.IMessage[] {
    // remove all 'system' messages
    const nonSystemMessages = messages.filter((m) => m._getType() !== "system");

    // requires alternate human & ai messages. Throw error if two messages are consecutive
    nonSystemMessages.forEach((msg, index) => {
      if (index < 1) return;
      if (msg._getType() === nonSystemMessages[index - 1]._getType()) {
        throw new Error(
          `Google PaLM requires alternate messages between authors`
        );
      }
    });

    return nonSystemMessages.map((m) => ({
      author: m.name ?? m._getType(),
      content: m.content,
      citationMetadata: {
        citationSources: m.additional_kwargs.citationSources as
          | protos.google.ai.generativelanguage.v1beta2.ICitationSource[]
          | undefined,
      },
    }));
  }

  protected _mapPalmMessagesToChatResult(
    msgRes: protos.google.ai.generativelanguage.v1beta2.IGenerateMessageResponse
  ): ChatResult {
    if (
      msgRes.candidates &&
      msgRes.candidates.length > 0 &&
      msgRes.candidates[0]
    ) {
      const message = msgRes.candidates[0];
      return {
        generations: [
          {
            text: message.content ?? "",
            message: new AIMessage({
              content: message.content ?? "",
              name: message.author === null ? undefined : message.author,
              additional_kwargs: {
                citationSources: message.citationMetadata?.citationSources,
                filters: msgRes.filters, // content filters applied
              },
            }),
          },
        ],
      };
    }
    // if rejected or error, return empty generations with reason in filters
    return {
      generations: [],
      llmOutput: {
        filters: msgRes.filters,
      },
    };
  }
}