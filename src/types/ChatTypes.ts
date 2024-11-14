export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface ChatCompletionOptions {
    temperature?: number;
    maxTokens?: number;
}
