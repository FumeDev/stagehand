import OpenAI, { ClientOptions, AzureOpenAI } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionUserMessageParam,
} from "openai/resources/chat";
import {
  getBearerTokenProvider,
  DefaultAzureCredential,
} from "@azure/identity";
import zodToJsonSchema from "zod-to-json-schema";
import { LogLine } from "../../types/log";
import { AvailableModel } from "../../types/model";
import { LLMCache } from "../cache/LLMCache";
import { validateZodSchema } from "../utils";
import {
  ChatCompletionOptions,
  ChatMessage,
  CreateChatCompletionOptions,
  LLMClient,
  LLMResponse,
} from "./LLMClient";
import {
  CreateChatCompletionResponseError,
  StagehandError,
} from "@/types/stagehandErrors";

export class OpenAIClient extends LLMClient {
  public type = "openai" as const;
  private client: OpenAI | AzureOpenAI;
  private cache: LLMCache | undefined;
  private enableCaching: boolean;
  public clientOptions: ClientOptions | Record<string, unknown>;

  constructor({
    enableCaching = false,
    cache,
    modelName,
    clientOptions,
  }: {
    logger: (message: LogLine) => void;
    enableCaching?: boolean;
    cache?: LLMCache;
    modelName: AvailableModel;
    clientOptions?: ClientOptions;
  }) {
    super(modelName);

    // Dynamically build client options so that Azure OpenAI can be used
    // transparently when its environment variables are available.
    // Support both AZURE_OPENAI_* and AZURE_API_* naming conventions
    const resolvedClientOptions: ClientOptions = clientOptions ?? {};

    const azureEndpoint =
      process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_API_BASE;
    const azureApiKey =
      process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY;
    const azureApiVersion =
      process.env.AZURE_OPENAI_API_VERSION ||
      process.env.AZURE_API_VERSION ||
      "2025-04-01-preview";

    if (azureEndpoint) {
      // Prefer API key authentication when available, as it's more reliable in local development
      if (azureApiKey) {
        // Forcefully remove OPENAI_BASE_URL environment variable to prevent conflict
        // with Azure OpenAI endpoint parameter (baseURL and endpoint are mutually exclusive)
        if (process.env.OPENAI_BASE_URL) {
          console.log(
            "Removing OPENAI_BASE_URL environment variable to prevent conflict with Azure OpenAI endpoint",
          );
          delete process.env.OPENAI_BASE_URL;
        }

        this.client = new AzureOpenAI({
          apiKey: azureApiKey,
          apiVersion: azureApiVersion,
          endpoint: azureEndpoint,
          deployment: modelName,
        });

        this.clientOptions = {
          apiKey: azureApiKey,
          apiVersion: azureApiVersion,
          endpoint: azureEndpoint,
          deployment: modelName,
        };
      } else {
        // Only try Azure AD authentication if no API key is available
        try {
          const credential = new DefaultAzureCredential();
          const scope = "https://cognitiveservices.azure.com/.default";
          const azureADTokenProvider = getBearerTokenProvider(
            credential,
            scope,
          );

          // Forcefully remove OPENAI_BASE_URL environment variable to prevent conflict
          // with Azure OpenAI endpoint parameter (baseURL and endpoint are mutually exclusive)
          if (process.env.OPENAI_BASE_URL) {
            console.log(
              "Removing OPENAI_BASE_URL environment variable to prevent conflict with Azure OpenAI endpoint",
            );
            delete process.env.OPENAI_BASE_URL;
          }

          this.client = new AzureOpenAI({
            azureADTokenProvider,
            apiVersion: azureApiVersion,
            endpoint: azureEndpoint,
            deployment: modelName,
          });

          this.clientOptions = {
            azureADTokenProvider,
            apiVersion: azureApiVersion,
            endpoint: azureEndpoint,
            deployment: modelName,
          };
        } catch (error) {
          throw new StagehandError(
            `Azure OpenAI endpoint is configured but authentication failed. Either set AZURE_API_KEY or configure Azure AD authentication (az login). Error: ${error.message}`,
          );
        }
      }
    } else {
      // Use standard OpenAI client
      if (process.env.OPENAI_API_KEY) {
        resolvedClientOptions.apiKey = process.env.OPENAI_API_KEY;
      }

      this.clientOptions = resolvedClientOptions;
      this.client = new OpenAI(this.clientOptions);
    }

    this.cache = cache;
    this.enableCaching = enableCaching;
    this.modelName = modelName;
  }

  async createChatCompletion<T = LLMResponse>({
    options: optionsInitial,
    logger,
    retries = 3,
  }: CreateChatCompletionOptions): Promise<T> {
    let options: Partial<ChatCompletionOptions> = optionsInitial;

    // O1 models do not support most of the options. So we override them.
    // For schema and tools, we add them as user messages.
    let isToolsOverridedForO1 = false;
    if (this.modelName.startsWith("o1") || this.modelName.startsWith("o3")) {
      /* eslint-disable */
      // Remove unsupported options
      let {
        tool_choice,
        top_p,
        frequency_penalty,
        presence_penalty,
        temperature,
      } = options;
      ({
        tool_choice,
        top_p,
        frequency_penalty,
        presence_penalty,
        temperature,
        ...options
      } = options);
      /* eslint-enable */
      // Remove unsupported options
      options.messages = options.messages.map((message) => ({
        ...message,
        role: "user",
      }));
      if (options.tools && options.response_model) {
        throw new StagehandError(
          "Cannot use both tool and response_model for o1 models",
        );
      }

      if (options.tools) {
        // Remove unsupported options
        let { tools } = options;
        ({ tools, ...options } = options);
        isToolsOverridedForO1 = true;
        options.messages.push({
          role: "user",
          content: `You have the following tools available to you:\n${JSON.stringify(
            tools,
          )}

          Respond with the following zod schema format to use a method: {
            "name": "<tool_name>",
            "arguments": <tool_args>
          }
          
          Do not include any other text or formattings like \`\`\` in your response. Just the JSON object.`,
        });
      }
    }
    if (
      options.temperature &&
      (this.modelName.startsWith("o1") || this.modelName.startsWith("o3"))
    ) {
      throw new StagehandError("Temperature is not supported for o1 models");
    }

    const { image, requestId, ...optionsWithoutImageAndRequestId } = options;

    logger({
      category: "openai",
      message: "creating chat completion",
      level: 2,
      auxiliary: {
        options: {
          value: JSON.stringify({
            ...optionsWithoutImageAndRequestId,
            requestId,
          }),
          type: "object",
        },
        modelName: {
          value: this.modelName,
          type: "string",
        },
      },
    });

    const cacheOptions = {
      model: this.modelName,
      messages: options.messages,
      temperature: options.temperature,
      top_p: options.top_p,
      frequency_penalty: options.frequency_penalty,
      presence_penalty: options.presence_penalty,
      image: image,
      response_model: options.response_model,
    };

    if (this.enableCaching) {
      const cachedResponse = await this.cache.get<T>(
        cacheOptions,
        options.requestId,
      );
      if (cachedResponse) {
        logger({
          category: "llm_cache",
          message: "LLM cache hit - returning cached response",
          level: 1,
          auxiliary: {
            requestId: {
              value: options.requestId,
              type: "string",
            },
            cachedResponse: {
              value: JSON.stringify(cachedResponse),
              type: "object",
            },
          },
        });
        return cachedResponse;
      } else {
        logger({
          category: "llm_cache",
          message: "LLM cache miss - no cached response found",
          level: 1,
          auxiliary: {
            requestId: {
              value: options.requestId,
              type: "string",
            },
          },
        });
      }
    }

    if (options.image) {
      const screenshotMessage: ChatMessage = {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${options.image.buffer.toString("base64")}`,
            },
          },
          ...(options.image.description
            ? [{ type: "text", text: options.image.description }]
            : []),
        ],
      };

      options.messages.push(screenshotMessage);
    }

    let responseFormat = undefined;
    if (options.response_model) {
      // For O1 models, we need to add the schema as a user message.
      if (this.modelName.startsWith("o1") || this.modelName.startsWith("o3")) {
        try {
          const parsedSchema = JSON.stringify(
            zodToJsonSchema(options.response_model.schema),
          );
          options.messages.push({
            role: "user",
            content: `Respond in this zod schema format:\n${parsedSchema}\n

          Do not include any other text, formatting or markdown in your output. Do not include \`\`\` or \`\`\`json in your response. Only the JSON object itself.`,
          });
        } catch (error) {
          logger({
            category: "openai",
            message: "Failed to parse response model schema",
            level: 0,
          });

          if (retries > 0) {
            // as-casting to account for o1 models not supporting all options
            return this.createChatCompletion({
              options: options as ChatCompletionOptions,
              logger,
              retries: retries - 1,
            });
          }

          throw error;
        }
      } else {
        responseFormat = zodResponseFormat(
          options.response_model.schema,
          options.response_model.name,
        );
      }
    }

    /* eslint-disable */
    // Remove unsupported options
    const { response_model, ...openAiOptions } = {
      ...optionsWithoutImageAndRequestId,
      model: this.modelName,
    };
    /* eslint-enable */

    logger({
      category: "openai",
      message: "creating chat completion",
      level: 2,
      auxiliary: {
        openAiOptions: {
          value: JSON.stringify(openAiOptions),
          type: "object",
        },
      },
    });

    const formattedMessages: ChatCompletionMessageParam[] =
      options.messages.map((message) => {
        if (Array.isArray(message.content)) {
          const contentParts = message.content.map((content) => {
            if ("image_url" in content) {
              const imageContent: ChatCompletionContentPartImage = {
                image_url: {
                  url: content.image_url.url,
                },
                type: "image_url",
              };
              return imageContent;
            } else {
              const textContent: ChatCompletionContentPartText = {
                text: content.text,
                type: "text",
              };
              return textContent;
            }
          });

          if (message.role === "system") {
            const formattedMessage: ChatCompletionSystemMessageParam = {
              ...message,
              role: "system",
              content: contentParts.filter(
                (content): content is ChatCompletionContentPartText =>
                  content.type === "text",
              ),
            };
            return formattedMessage;
          } else if (message.role === "user") {
            const formattedMessage: ChatCompletionUserMessageParam = {
              ...message,
              role: "user",
              content: contentParts,
            };
            return formattedMessage;
          } else {
            const formattedMessage: ChatCompletionAssistantMessageParam = {
              ...message,
              role: "assistant",
              content: contentParts.filter(
                (content): content is ChatCompletionContentPartText =>
                  content.type === "text",
              ),
            };
            return formattedMessage;
          }
        }

        const formattedMessage: ChatCompletionUserMessageParam = {
          role: "user",
          content: message.content,
        };

        return formattedMessage;
      });

    const body: ChatCompletionCreateParamsNonStreaming = {
      ...openAiOptions,
      model: this.modelName,
      messages: formattedMessages,
      response_format: responseFormat,
      stream: false,
      tools: options.tools?.map((tool) => ({
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
        type: "function",
      })),
    };

    const response = await this.client.chat.completions.create(body);

    // For O1 models, we need to parse the tool call response manually and add it to the response.
    if (isToolsOverridedForO1) {
      try {
        const parsedContent = JSON.parse(response.choices[0].message.content);

        response.choices[0].message.tool_calls = [
          {
            function: {
              name: parsedContent["name"],
              arguments: JSON.stringify(parsedContent["arguments"]),
            },
            type: "function",
            id: "-1",
          },
        ];
        response.choices[0].message.content = null;
      } catch (error) {
        logger({
          category: "openai",
          message: "Failed to parse tool call response",
          level: 0,
          auxiliary: {
            error: {
              value: error.message,
              type: "string",
            },
            content: {
              value: response.choices[0].message.content,
              type: "string",
            },
          },
        });

        if (retries > 0) {
          // as-casting to account for o1 models not supporting all options
          return this.createChatCompletion({
            options: options as ChatCompletionOptions,
            logger,
            retries: retries - 1,
          });
        }

        throw error;
      }
    }

    logger({
      category: "openai",
      message: "response",
      level: 2,
      auxiliary: {
        response: {
          value: JSON.stringify(response),
          type: "object",
        },
        requestId: {
          value: requestId,
          type: "string",
        },
      },
    });

    if (options.response_model) {
      const extractedData = response.choices[0].message.content;
      const parsedData = JSON.parse(extractedData);

      if (!validateZodSchema(options.response_model.schema, parsedData)) {
        if (retries > 0) {
          // as-casting to account for o1 models not supporting all options
          return this.createChatCompletion({
            options: options as ChatCompletionOptions,
            logger,
            retries: retries - 1,
          });
        }

        throw new CreateChatCompletionResponseError("Invalid response schema");
      }

      if (this.enableCaching) {
        this.cache.set(
          cacheOptions,
          {
            ...parsedData,
          },
          options.requestId,
        );
      }

      return {
        data: parsedData,
        usage: response.usage,
      } as T;
    }

    if (this.enableCaching) {
      logger({
        category: "llm_cache",
        message: "caching response",
        level: 1,
        auxiliary: {
          requestId: {
            value: options.requestId,
            type: "string",
          },
          cacheOptions: {
            value: JSON.stringify(cacheOptions),
            type: "object",
          },
          response: {
            value: JSON.stringify(response),
            type: "object",
          },
        },
      });
      this.cache.set(cacheOptions, response, options.requestId);
    }

    // if the function was called with a response model, it would have returned earlier
    // so we can safely cast here to T, which defaults to ChatCompletion
    return response as T;
  }
}
